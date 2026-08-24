/**
 * The overlay's own entry. Separate from the main window on purpose:
 * a looser CSP (wasm + file: textures) and ~120MB of 3D runtime stay out
 * of the chat bundle entirely.
 */
import { createRoot } from 'react-dom/client';
import { AvatarSurface } from './AvatarSurface';
import './avatar.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(<AvatarSurface />);
