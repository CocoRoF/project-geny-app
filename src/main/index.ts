/**
 * Electron entry. Deliberately thin: it wires ports into the core modules
 * and owns nothing else. (xgen-connector's 3,330-line index.ts is the
 * anti-pattern this file exists to avoid.)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { agentDir as resolveAgentDir, layout, resolveDataRoot } from './data-root';
import { openStore } from './db';
import { EngineService } from './engine-service';
import { forwardEvent, registerIpc } from './ipc';
import { createSecretStore } from './secrets';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let engine: EngineService | null = null;

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

  engine = new EngineService({
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
    skillDirs: (id) => [join(paths.dataRoot, 'skills'), join(resolveAgentDir(paths, id), 'skills')],
    commandDirs: (id) => [join(paths.dataRoot, 'commands'), join(resolveAgentDir(paths, id), 'commands')],
    emit: (event) => forwardEvent(mainWindow, event),
    persistAssistant: (agentId, text) => {
      store.messages.append({ agentId, role: 'assistant', text });
    },
    onStatus: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine:statusEvent', status);
      }
    },
    log: (line) => {
      if (isDev) console.log('[engine]', line);
    },
  });

  registerIpc({
    ipcMain,
    shell,
    window: () => mainWindow,
    store,
    secrets,
    engine,
    layout: paths,
    paths: { dataRoot: resolved.dataRoot, portable: resolved.portable },
    agentDir: (id) => resolveAgentDir(paths, id),
  });

  mainWindow = createWindow();
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
  void engine?.stop();
});
