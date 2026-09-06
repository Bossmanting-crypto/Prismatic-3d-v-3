/* ══════════════════════════════════════════════════════════
   Bridge

   The renderer talks to exactly one object, `window.prism`. This
   file is the only thing that knows it is running under Tauri, so
   the viewer, the lens and the annotation code are untouched by
   the choice of shell.
   ══════════════════════════════════════════════════════════ */

(function () {
  const T = window.__TAURI__;
  if (!T) {
    console.warn('Tauri APIs not present — running as a plain page.');
    return;
  }

  const invoke = T.core.invoke;
  const listen = T.event.listen;

  let openHandler = null;
  let commandHandler = null;

  const MODEL_EXT = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', '3mf', 'dae'];
  const extOf = (p) => p.split('.').pop().toLowerCase();

  function open(path) {
    if (openHandler && path) openHandler(path);
  }

  /* Native events from the shell: file associations, second launches,
     menu clicks and drag-and-drop from Explorer. */
  listen('open-path', (e) => open(e.payload));

  listen('command', (e) => {
    if (commandHandler) commandHandler(e.payload);
  });

  // Tauri intercepts drops before the DOM sees them, and hands over
  // real paths — which is what lets sibling textures come along.
  listen('tauri://drag-drop', (e) => {
    const paths = (e.payload && e.payload.paths) || [];
    const model = paths.find((p) => MODEL_EXT.includes(extOf(p)));
    if (model) open(model);
    else if (paths.length) {
      window.dispatchEvent(
        new CustomEvent('prism-drop-rejected', { detail: paths })
      );
    }
  });

  /* Base64 in bounded slices: a large export never has to exist as one
     giant string. 3 MB divides by 3, so no padding lands mid-stream. */
  const CHUNK = 3 * 1024 * 1024;

  function toBase64(bytes, from, to) {
    let s = '';
    for (let i = from; i < to; i += 8192) {
      s += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(i + 8192, to))
      );
    }
    return btoa(s);
  }

  async function save({ defaultName, filters, data }) {
    const path = await invoke('save_dialog', {
      req: { defaultName, filters: filters || [] }
    });
    if (!path) return { saved: false };

    const bytes =
      data instanceof Uint8Array ? data : new Uint8Array(data);

    let name = '';
    if (bytes.length === 0) {
      name = await invoke('write_chunk', { path, chunk: '', append: false });
    } else {
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const end = Math.min(i + CHUNK, bytes.length);
        name = await invoke('write_chunk', {
          path,
          chunk: toBase64(bytes, i, end),
          append: i > 0
        });
      }
    }
    return { saved: true, filePath: path, name };
  }

  window.prism = {
    isDesktop: true,
    platform: 'windows',
    versions: { shell: 'tauri2' },

    openDialog: async () => open(await invoke('pick_model')),
    openFolder: async () => open(await invoke('pick_folder')),

    /* Returns `model://` URLs, not bytes. The webview streams each file
       off disk as the loader asks for it. */
    readModel: (path) => invoke('read_model', { path }),

    save,
    showItem: (path) => invoke('reveal', { path }),
    recent: () => invoke('recent_list'),
    setTitle: (title) => invoke('set_title', { title: title || '' }),

    getViews: (key) => invoke('get_notes', { kind: 'views', key }),
    setViews: (key, list) => invoke('set_notes', { kind: 'views', key, list }),
    getCallouts: (key) => invoke('get_notes', { kind: 'labels', key }),
    setCallouts: (key, list) =>
      invoke('set_notes', { kind: 'labels', key, list }),

    reportError: (title, detail) => console.error(title, detail),

    // Drops arrive as native paths, so the DOM fallback is never needed.
    pathFor: () => null,

    onOpenPath: (fn) => { openHandler = fn; },
    onCommand: (fn) => { commandHandler = fn; }
  };
})();
