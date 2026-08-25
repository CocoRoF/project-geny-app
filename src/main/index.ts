/**
 * Electron entry. Deliberately thin: it wires ports into the core modules
 * and owns nothing else. (xgen-connector's 3,330-line index.ts is the
 * anti-pattern this file exists to avoid.)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  app, BrowserWindow, clipboard, desktopCapturer, ipcMain, Menu, nativeImage,
  Notification, safeStorage, screen, shell, Tray,
} from 'electron';
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

/** Every surface a sidecar event should reach. The avatar is one of them:
 *  it reacts to the agent thinking and speaking, so it needs the same
 *  stream the chat window gets. */
const surfaces = (): Array<BrowserWindow | null> => [
  mainWindow,
  quickChat?.window() ?? null,
  avatar?.window() ?? null,
];

function createWindow(): BrowserWindow {
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
  win.once('ready-to-show', () => win.show());
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

  const hostTools = buildHostTools({
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
    captureScreen: async () => {
      const { width, height } = screen.getPrimaryDisplay().size;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height },
      });
      const shot = sources[0]?.thumbnail;
      if (!shot || shot.isEmpty()) throw new Error('screen capture unavailable');
      const size = shot.getSize();
      return { mime: 'image/png', base64: shot.toPNG().toString('base64'), ...size };
    },
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
      for (const win of surfaces()) {
        if (win && !win.isDestroyed()) win.webContents.send('engine:statusEvent', status);
      }
    },
    log: (line) => {
      if (isDev) console.log('[engine]', line);
    },
  });

  const updater = new Updater({
    isPackaged: app.isPackaged,
    platform: process.platform,
    window: () => mainWindow,
    onState: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', state);
    },
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

  registerIpc({
    ipcMain,
    avatar,
    voice,
    knowledge,
    showQuickChat: () => quickChat?.show(),
    hideQuickChat: () => quickChat?.hide(),
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

  mainWindow = createWindow();

  // Quick chat + tray: the point of a desktop app is being reachable without
  // being in front of you.
  const paths2 = quickChatPaths(import.meta.dirname);
  quickChat = new QuickChat({
    preload: paths2.preload,
    devServerUrl: process.env.ELECTRON_RENDERER_URL ?? null,
    rendererFile: paths2.rendererFile,
  });
  const shortcut = quickChat.registerShortcut(
    store.settings.get('quickChat.shortcut') || DEFAULT_SHORTCUT,
  );
  if (!shortcut) {
    // another app owns the accelerator; say so instead of silently doing
    // nothing when the user presses it
    store.settings.set('quickChat.shortcutError', 'in use by another app');
  } else {
    store.settings.set('quickChat.shortcutActive', shortcut);
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '창 열기', click: () => mainWindow?.show() },
      { label: `퀵챗 (${shortcut ?? '단축키 사용 불가'})`, click: () => quickChat?.show() },
      {
        label: '아바타 표시',
        type: 'checkbox',
        checked: avatar?.state().visible ?? false,
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
      { label: '데이터 폴더', click: () => void shell.openPath(resolved.dataRoot) },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ]),
  );

  // the overlay comes back where the user left it, showing or not
  avatar.restore();

  // start the engine eagerly: first-token latency is the whole UX
  void engine.start();
}

void app.whenReady().then(boot);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
});
app.on('before-quit', () => {
  browserHostRef?.destroyAll();
  avatar?.destroy();
  quickChat?.destroy();
  tray?.destroy();
  void engine?.stop();
});
