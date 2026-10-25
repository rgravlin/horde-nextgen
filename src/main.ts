// Composition root. This task is the scaffold only: the fonts load here and a
// placeholder proves the canvas container and the #ui overlay mount. The
// renderer, audio, HUD and input wire up here in later tasks (ARCHITECTURE.md).
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/ibm-plex-mono/700.css';

const ui = document.getElementById('ui');

if (ui) {
  const note = document.createElement('p');
  note.className = 'placeholder';
  note.textContent = 'Neon Horde — scaffold, no renderer yet';
  ui.appendChild(note);
}
