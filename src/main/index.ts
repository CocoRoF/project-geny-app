/**
 * Electron entry. Deliberately thin: it wires ports into the core modules
 * and owns nothing else. (xgen-connector's 3,330-line index.ts is the
 * anti-pattern this file exists to avoid.)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain,
  Menu, nativeImage, Notification, safeStorage, screen, shell, Tray,
} from 'electron';
import {
  applyAutostart, autostartActive, claimSingleInstance, launchedHidden, LogRing,
  respawnDetached,
} from './app-shell';
import { ComputerUse, type ComputerUseConfig } from './computer-use';
import { HOTKEYS, Hotkeys, type HotkeyId } from './hotkeys';
import { AvatarController } from './avatar';
import { avatarWindowPaths } from './avatar-window';
import { agentDir as resolveAgentDir, layout, resolveDataRoot } from './data-root';
import { openStore } from './db';
import { EngineService } from './engine-service';
import { BrowserHost } from './browser-tools';
import { buildHostTools } from './host-tools';
import { ensureHooksExample, resolveHooksFile } from './hooks-file';
import { KnowledgeStore } from './knowledge';
import { ensureStarters } from './personas';
import { DEFAULT_SHORTCUT, QuickChat, quickChatPaths } from './quick-chat';
import { forwardEvent, registerIpc } from './ipc';
import { createSecretStore } from './secrets';
import { Updater } from './updater';
import { VoiceService } from './voice/service';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let engine: EngineService | null = null;
let quickChat: QuickChat | null = null;
let tray: Tray | null = null;
let browserHostRef: BrowserHost | null = null;
let avatar: AvatarController | null = null;
let hotkeys: Hotkeys | null = null;
let updaterRef: Updater | null = null;
let computerUse: ComputerUse | null = null;
let rebuildTray: (() => void) | null = null;

/** Everything the app says about itself, readable from inside the app. */
const logs = new LogRing();
logs.subscribe((line) => {
  for (const win of surfaces()) {
    if (win && !win.isDestroyed()) win.webContents.send('system:log', line);
  }
});

/**
 * ONE INSTANCE PER DATA ROOT.
 *
 * Two copies over one SQLite file, one agent workspace and one engine is a
 * real corruption risk, and it looks like a haunting rather than a bug: two
 * trays, two avatars, turns landing in the wrong window. Claimed before
 * `whenReady` because a second process must die before it builds anything.
 */
const singleInstance = claimSingleInstance(app, process.env.GENY_DATA_ROOT, () => {
  // launching again is a request to SEE the app
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

/** Every surface a sidecar event should reach. The avatar is one of them:
 *  it reacts to the agent thinking and speaking, so it needs the same
 *  stream the chat window gets. */
const surfaces = (): Array<BrowserWindow | null> => [
  mainWindow,
  quickChat?.window() ?? null,
  avatar?.window() ?? null,
];

/**
 * Capture a screen or window.
 *
 * `sourceId` lets the user pick which display or application window the
 * agent sees — the primary display is a poor default on a multi-monitor desk
 * and useless when the thing to look at is a single window.
 */
async function captureScreen(
  sourceId?: string,
): Promise<{ mime: string; base64: string; width: number; height: number }> {
  const { width, height } = screen.getPrimaryDisplay().size;
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width, height },
  });
  // a remembered source that has since gone away must not become a silent
  // capture of something else — fall back to the primary screen explicitly
  const chosen =
    (sourceId ? sources.find((s) => s.id === sourceId) : undefined) ??
    sources.find((s) => s.id.startsWith('screen:')) ??
    sources[0];
  const shot = chosen?.thumbnail;
  if (!shot || shot.isEmpty()) throw new Error('screen capture unavailable');
  return { mime: 'image/png', base64: shot.toPNG().toString('base64'), ...shot.getSize() };
}

export async function listCaptureSources(): Promise<Array<{ id: string; name: string; kind: 'screen' | 'window' }>> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1, height: 1 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
  }));
}

function showMain(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    mainWindow = createWindow(false);
  }
}

function createWindow(startHidden = false): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'Geny',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

async function boot(): Promise<void> {
  const override = process.env.GENY_DATA_ROOT;
  const resolved = resolveDataRoot({
    execPath: app.getPath('exe'),
    userData: app.getPath('userData'),
    override,
    isPackaged: app.isPackaged,
  });
  const paths = layout(resolved.dataRoot);
  // written once so the folder is never empty and the format documents itself
  ensureStarters(resolved.dataRoot);
  ensureHooksExample(resolved.dataRoot);
  // user-authored capability folders — created empty so they are
  // discoverable in the file manager rather than documented-only
  for (const sub of ['skills', 'commands']) {
    mkdirSync(join(resolved.dataRoot, sub), { recursive: true });
  }
  logs.push('app', `Geny ${app.getVersion()} — ${process.platform} ${process.arch}, electron ${process.versions.electron}`);
  logs.push('app', `data root: ${resolved.dataRoot}${resolved.portable ? ' (portable)' : ''}`);

  const store = openStore(paths.db);
  const secrets = createSecretStore(paths.secrets, safeStorage);

  // dev runs the repo venv; packaged runs the bundled tree copied into
  // <data-root>/runtime, with resources/ as the pristine source
  const repoRoot = join(import.meta.dirname, '..', '..');
  const devVenv = process.platform === 'win32'
    ? join(repoRoot, 'engine', '.venv', 'Scripts', 'python.exe')
    : join(repoRoot, 'engine', '.venv', 'bin', 'python');

  // The app's own capabilities, offered to the agent as tools. This is the
  // only path by which anything Electron can do reaches the engine.
  // one browser window per agent, shown so the user can see what the agent
  // is doing rather than discovering it afterwards
  const browserHost = new BrowserHost({ show: true });
  browserHostRef = browserHost;

  // the user's documents, indexed locally — no API calls, no new deps
  const knowledge = new KnowledgeStore(resolved.dataRoot);

  // Voice is a CLIENT, never a server: this app serves no audio. It calls
  // OpenAI, a self-hosted geny-audio-services box, a user-described
  // endpoint, or the OS's own voice.
  const voice = new VoiceService({
    settings: store.settings,
    secrets: {
      get: (key) => secrets.get(key),
      set: (key, value) => secrets.set(key, value),
      delete: (key) => secrets.remove(key),
    },
    play: (audio) => {
      // EXACTLY one surface plays it, or the user hears it twice. The
      // avatar gets first refusal when it is up, because it drives its
      // mouth from the waveform; otherwise the main window plays it.
      const target = avatar?.window() ?? mainWindow;
      const win = target && !target.isDestroyed() ? target : mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send('voice:audio', audio);
    },
  });

  // ── computer use: the agent acting as the user ──────────────────────────
  computerUse = new ComputerUse({
    read: () => {
      try {
        return JSON.parse(store.settings.get('computerUse') ?? '{}') as Partial<ComputerUseConfig>;
      } catch {
        return {};
      }
    },
    write: (config) => {
      store.settings.set('computerUse', JSON.stringify(config));
      rebuildTray?.();
    },
    // A modal, on top, naming the exact action — approving "input" in the
    // abstract is not consent to what is about to be typed.
    ask: async ({ capability, action, detail }) => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['허용', '이번 실행 동안 허용', '거부'],
        defaultId: 2,
        cancelId: 2,
        noLink: true,
        title: '컴퓨터 조작 요청',
        message: `에이전트가 ${action} 을(를) 하려고 합니다`,
        detail: `${detail}\n\n권한: ${capability}`,
      });
      return response === 0 ? 'allow' : response === 1 ? 'session' : 'deny';
    },
    clipboardWrite: (text) => clipboard.writeText(text),
    openPath: async (target) => {
      if (/^https?:\/\//i.test(target)) await shell.openExternal(target);
      else await shell.openPath(target);
    },
    log: (line) => logs.push('computer', line),
  });

  const hostTools = buildHostTools({
    computer: {
      type: (text) => computerUse!.type(text),
      key: (combo) => computerUse!.key(combo),
      click: (x, y, button) => computerUse!.click(x, y, button),
      move: (x, y) => computerUse!.move(x, y),
      scroll: (amount) => computerUse!.scroll(amount),
      openApp: (target) => computerUse!.openApp(target),
      noteCapture: (w, h) => computerUse!.noteCapture(w, h),
    },
    voice: {
      enabled: () => voice.enabled(),
      speak: (text) => voice.speak(text),
      transcribe: (input) => voice.transcribe(input),
    },
    knowledge: {
      search: (query, limit) => knowledge.search(query, limit),
      read: (path) => knowledge.read(path),
      stats: () => knowledge.stats(),
    },
    browser: {
      navigate: (id, url) => browserHost.navigate(id, url),
      snapshot: (id) => browserHost.snapshot(id),
      act: (id, input) => browserHost.act(id, input),
      extract: (id) => browserHost.extract(id),
      back: (id) => browserHost.back(id),
      close: (id) => browserHost.close(id),
    },
    captureScreen: async () => captureScreen(store.settings.get('capture.sourceId')),
    notify: ({ title, body }) => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
    clipboardRead: () => clipboard.readText(),
    clipboardWrite: (text) => clipboard.writeText(text),
    openPath: async (target) => {
      await shell.openPath(target);
    },
    say: ({ agentId, level, message }) => {
      for (const win of surfaces()) {
        if (win && !win.isDestroyed()) win.webContents.send('chat:hostSay', { agentId, level, message });
      }
    },
  });

  engine = new EngineService({
    hostTools,
    cwd: isDev ? repoRoot : process.resourcesPath,
    locate: {
      installRoot: paths.runtime,
      bundleRoot: app.isPackaged ? process.resourcesPath : null,
      devVenvExe: isDev && existsSync(devVenv) ? devVenv : null,
      cwd: isDev ? repoRoot : process.resourcesPath,
    },
    secret: (provider) => secrets.get(`apiKey:${provider}`),
    agentDir: (id) => resolveAgentDir(paths, id),
    mcpFor: (id) =>
      store.mcp.forAgent(id).map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env,
      })),
    // global first, then the agent's own — a per-agent skill shadows a
    // global one of the same id, which is the intuitive precedence
    hooksFile: (id) => resolveHooksFile(resolved.dataRoot, resolveAgentDir(paths, id)),
    skillDirs: (id) => [join(paths.dataRoot, 'skills'), join(resolveAgentDir(paths, id), 'skills')],
    commandDirs: (id) => [join(paths.dataRoot, 'commands'), join(resolveAgentDir(paths, id), 'commands')],
    emit: (event) => forwardEvent(surfaces(), event),
    persistAssistant: (agentId, text) => {
      store.messages.append({ agentId, role: 'assistant', text });
      // Speaking is opt-in and happens once per turn, from the whole reply
      // — reading each chunk as it arrives would stutter and overlap.
      if (voice.config().tts.autoSpeak) {
        // a 4,000-word answer is not something anyone wants read aloud, and
        // a GPU box would be busy for minutes producing it
        const spoken = text.trim().slice(0, 600);
        if (spoken) {
          void voice.speak(spoken).catch((err: unknown) => {
            const why = err instanceof Error ? err.message : String(err);
            for (const win of surfaces()) {
              if (win && !win.isDestroyed()) {
                win.webContents.send('chat:hostSay', { agentId, level: 'warn', message: `음성 재생 실패: ${why}` });
              }
            }
          });
        }
      }
    },
    onStatus: (status) => {
      // the engine's state changes are the single most useful thing in the
      // log when something is wrong, and they are invisible otherwise
      logs.push(
        'engine',
        status.state === 'ready'
          ? `ready — executor ${status.engine} · python ${status.python} · runtime ${status.runtime?.source}`
          : status.state === 'failed'
            ? `failed — ${status.error ?? 'unknown'}`
            : status.state,
        status.state === 'failed' ? 'error' : 'info',
      );
      for (const win of surfaces()) {
        if (win && !win.isDestroyed()) win.webContents.send('engine:statusEvent', status);
      }
    },
    log: (line) => {
      logs.push('engine', line);
      if (isDev) console.log('[engine]', line);
    },
  });

  const updater = new Updater({
    isPackaged: app.isPackaged,
    platform: process.platform,
    version: app.getVersion(),
    window: () => mainWindow,
    onState: (state) => {
      for (const win of surfaces()) {
        if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
      }
      rebuildTray?.();
    },
    enabled: () => store.settings.get('update.enabled') !== 'false',
    setEnabled: (value) => {
      store.settings.set('update.enabled', String(value));
      rebuildTray?.();
    },
    notify: ({ title, body, onClick }) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      if (onClick) n.on('click', onClick);
      n.show();
    },
    confirmRestart: async (version) => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['지금 재시작', '나중에'],
        defaultId: 0,
        cancelId: 1,
        title: '업데이트 준비됨',
        message: `Geny ${version} 을(를) 받았습니다.`,
        detail: '지금 재시작하면 새 버전으로 설치됩니다. 나중을 고르면 앱을 껐을 때 설치됩니다.',
      });
      return response === 0;
    },
    // A Linux package install goes through Electron's relauncher, which
    // hands NoNewPrivs to the new process; the SUID chrome-sandbox then
    // cannot elevate and the app dies with SIGTRAP on Ubuntu 24.04. Come
    // back up ourselves instead, from a process that still has NNP=0.
    beforeQuitForUpdate: () => {
      if (process.platform === 'linux' && !process.env.APPIMAGE) {
        app.once('before-quit-for-update' as 'before-quit', () => respawnDetached(process.execPath));
      }
    },
    log: (line) => logs.push('updater', line),
  });

  // Test seam: run a host tool exactly as the engine's host_tool_call does,
  // without needing a model in the loop. Only reachable from the main
  // process (Playwright's app.evaluate), never from a renderer or a page.
  (globalThis as unknown as Record<string, unknown>).__genyHostTool = async (
    name: string,
    args: Record<string, unknown>,
    forAgent: string,
  ): Promise<unknown> => {
    const tool = hostTools.find((t) => t.spec.name === name);
    if (!tool) throw new Error(`unknown host tool ${name}`);
    return tool.handle(args, { agentId: forAgent, agentDir: resolveAgentDir(paths, forAgent) });
  };

  const avatarPaths = avatarWindowPaths(import.meta.dirname);
  avatar = new AvatarController({
    dataRoot: resolved.dataRoot,
    settings: store.settings,
    live2d: {
      resourceDir: join(process.resourcesPath, 'live2d'),
      repoRoot,
      packaged: app.isPackaged,
    },
    window: {
      preload: avatarPaths.preload,
      devServerUrl: process.env.ELECTRON_RENDERER_URL ?? null,
      rendererFile: avatarPaths.rendererFile,
    },
    publish: (state) => {
      for (const win of surfaces()) {
        if (win && !win.isDestroyed()) win.webContents.send('avatar:stateEvent', state);
      }
    },
  });

  // Test seam: the screenshot→screen mapping is only exercised when the two
  // differ, and a real capture always matches the display. Main process only
  // (Playwright's app.evaluate), never a renderer.
  (globalThis as unknown as Record<string, unknown>).__genyNoteCapture = (w: number, h: number): void =>
    computerUse!.noteCapture(w, h);

  registerIpc({
    ipcMain,
    system: {
      hotkeys: {
        list: () => ({ definitions: HOTKEYS, state: hotkeys!.state() }),
        set: (id, accelerator) => hotkeys!.set(id as HotkeyId, accelerator),
        reset: () => hotkeys!.reset(),
        pause: () => hotkeys!.pause(),
        resume: () => hotkeys!.resume(),
      },
      autostart: {
        get: () => autostartActive(app),
        set: (enabled) => {
          const result = applyAutostart(app, enabled);
          if (!result.applied && result.reason) logs.push('autostart', result.reason, 'warn');
          rebuildTray?.();
          return result;
        },
      },
      logs: {
        all: () => logs.all(),
        text: () => logs.text(),
        clear: () => logs.clear(),
      },
      capture: {
        sources: () => listCaptureSources(),
        get: () => store.settings.get('capture.sourceId'),
        set: (id) => {
          if (id) store.settings.set('capture.sourceId', id);
          else store.settings.set('capture.sourceId', '');
        },
      },
      computer: {
        status: () => computerUse!.status(),
        save: async (patch) => {
          computerUse!.save(patch as Partial<ComputerUseConfig>);
          return computerUse!.status();
        },
      },
      // an explicit restart is the honest fix for anything that needs one,
      // and it is how a changed engine setting takes hold
      restart: () => {
        app.relaunch();
        app.exit(0);
      },
    },
    avatar,
    voice,
    knowledge,
    showQuickChat: () => quickChat?.show(),
    hideQuickChat: () => quickChat?.hide(),
    resizeQuickChat: (height) => quickChat?.resize(height),
    shell,
    window: () => mainWindow,
    store,
    secrets,
    engine,
    updater,
    layout: paths,
    paths: { dataRoot: resolved.dataRoot, portable: resolved.portable },
    agentDir: (id) => resolveAgentDir(paths, id),
  });

  // An autostart launch should land in the tray, not throw a window in front
  // of whatever the user is doing at login.
  const hidden = launchedHidden();
  mainWindow = createWindow(hidden);

  // Quick chat + tray: the point of a desktop app is being reachable without
  // being in front of you.
  const paths2 = quickChatPaths(import.meta.dirname);
  quickChat = new QuickChat({
    preload: paths2.preload,
    devServerUrl: process.env.ELECTRON_RENDERER_URL ?? null,
    rendererFile: paths2.rendererFile,
  });
  // ── global hotkeys ──────────────────────────────────────────────────────
  // Rebindable, because CommandOrControl+Shift+G is already taken on plenty
  // of desktops and a hardcoded accelerator fails SILENTLY when it is.
  hotkeys = new Hotkeys({
    shortcut: globalShortcut,
    read: () => {
      try {
        return JSON.parse(store.settings.get('hotkeys') ?? '{}') as Partial<Record<HotkeyId, string>>;
      } catch {
        return {};
      }
    },
    write: (map) => store.settings.set('hotkeys', JSON.stringify(map)),
    fire: (id) => {
      if (id === 'quickChat') quickChat?.toggle();
      else if (id === 'toggleAvatar') {
        try {
          avatar?.toggle();
        } catch {
          /* no model — the hotkey must not crash the app */
        }
        rebuildTray?.();
      } else if (id === 'pushToTalk') {
        // the surface that can reach a microphone owns this
        for (const win of surfaces()) {
          if (win && !win.isDestroyed()) win.webContents.send('hotkey:pushToTalk');
        }
        quickChat?.show();
      }
    },
  });
  logs.push('hotkeys', 'registering global accelerators');
  const bound = hotkeys.apply();
  for (const state of bound) {
    if (state.accelerator && !state.bound) {
      logs.push('hotkeys', `${state.id}: '${state.accelerator}' is held by another app`, 'warn');
    }
  }

  // An empty image is an INVISIBLE tray icon — and on Linux the tray is the
  // only way to reach the avatar toggle and the quick-chat entry, so the app
  // would look like it simply had no tray. `@2x` resolves by filename.
  const trayIcon = app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(repoRoot, 'build', 'tray.png');
  const trayImage = nativeImage.createFromPath(trayIcon);
  tray = new Tray(trayImage.isEmpty() ? nativeImage.createEmpty() : trayImage);
  // Test seam: Electron 43's Tray has no statics, so there is no way to ask
  // it from outside whether its icon is real. Reachable only from the main
  // process (Playwright's app.evaluate), never from a renderer.
  (globalThis as unknown as Record<string, unknown>).__genyTray = {
    path: trayIcon,
    empty: trayImage.isEmpty(),
    size: trayImage.isEmpty() ? null : trayImage.getSize(),
  };
  tray.setToolTip('Geny');

  // Rebuilt rather than mutated: Electron's menu items are snapshots, so a
  // checkbox left over from the last build reports stale state.
  rebuildTray = (): void => {
    if (!tray || tray.isDestroyed()) return;
    const quickChatKey = hotkeys?.state().find((h) => h.id === 'quickChat');
    const avatarState = (() => {
      try {
        return avatar?.state() ?? null;
      } catch {
        return null;
      }
    })();
    const cu = computerUse?.config();
    const update = updater.current;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '창 열기', click: () => showMain() },
        {
          label: quickChatKey?.bound
            ? `퀵챗 (${quickChatKey.accelerator})`
            : '퀵챗 (단축키 사용 불가)',
          click: () => quickChat?.show(),
        },
        {
          label: '아바타 표시',
          type: 'checkbox',
          enabled: avatarState?.available ?? false,
          checked: avatarState?.visible ?? false,
          click: (item) => {
            try {
              item.checked = avatar?.toggle().visible ?? false;
            } catch {
              // no model installed — the checkbox must not lie about it
              item.checked = false;
            }
          },
        },
        { type: 'separator' },
        {
          label: '컴퓨터 조작 허용',
          type: 'checkbox',
          checked: cu?.enabled ?? false,
          // a panic switch: whatever the agent is in the middle of, this
          // stops it being able to type
          click: (item) => {
            computerUse?.save({ enabled: item.checked });
          },
        },
        {
          label: '로그인 시 자동 시작',
          type: 'checkbox',
          checked: autostartActive(app),
          click: (item) => {
            const result = applyAutostart(app, item.checked);
            item.checked = result.enabled;
            if (!result.applied && result.reason) {
              logs.push('autostart', result.reason, 'warn');
              void dialog.showMessageBox({ type: 'warning', message: '자동 시작을 설정하지 못했습니다', detail: result.reason });
            }
          },
        },
        { type: 'separator' },
        {
          label:
            update.status === 'ready'
              ? `업데이트 설치하고 재시작 (v${update.version})`
              : update.status === 'downloading'
                ? `업데이트 받는 중 ${update.percent ?? 0}%`
                : '업데이트 확인',
          click: () => {
            if (update.status === 'ready') void updater.installNow();
            else void updater.check();
          },
        },
        { label: '데이터 폴더', click: () => void shell.openPath(resolved.dataRoot) },
        { type: 'separator' },
        { label: '종료', click: () => app.quit() },
      ]),
    );
  };
  rebuildTray();
  updaterRef = updater;

  // the overlay comes back where the user left it, showing or not
  avatar.restore();

  // start the engine eagerly: first-token latency is the whole UX
  void engine.start();
  // and start looking for updates, on the schedule rather than on demand
  updater.start();
  logs.push('updater', updater.current.channel ?? 'idle');
}

if (singleInstance) void app.whenReady().then(boot);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(false);
  else showMain();
});
app.on('before-quit', () => {
  hotkeys?.dispose();
  updaterRef?.stop();
  browserHostRef?.destroyAll();
  avatar?.destroy();
  quickChat?.destroy();
  tray?.destroy();
  void engine?.stop();
});
