// Scan: the camera reads a Ting QR code (a pay link, a program's call link, a
// create link, a device link, a guardian code, a recover code) and opens it,
// as Ting ID's scanner does; a link someone sent is pasted instead, here or
// with Paste on the wallet. The browser's own
// barcode reader is used where there is one; elsewhere, Safari on iPhone
// among them, the wallet's own decoder (qr-decode.js). Nothing leaves the
// device: frames are read in the page and dropped.
import { hold, INSIDE_ONLY, requestOf, REQUESTS } from '../links.js';
import { $, ask, esc, icon, toast } from '../ui.js';

let running = null;

/** Stops the camera, if it runs. */
export function stopScanning() {
  if (!running) return;
  running.stop = true;
  for (const track of running.stream?.getTracks() ?? []) track.stop();
  running = null;
}

/**
 * The Ting link in what a code holds: `ting:…`, or a wallet address with
 * `#ting:…`. Only a `ting:` that starts a word counts: "Meeting: 3pm" holds
 * no link.
 */
function tingLink(text) {
  const t = String(text);
  const m = /(?:^|[^a-z0-9])ting:/i.exec(t);
  return m ? t.slice(m.index + m[0].length - 'ting:'.length) : null;
}

/** The screens of links that open only from inside the wallet. */
const INSIDE = { device: '#/add-device', guardian: '#/add-guardian', recover: '#/approve-recovery' };

/**
 * Opens the Ting link in `text`: true when it did, else why not, in words
 * for a toast. A device, guardian or recover link is held in memory for its
 * screen, never put in the address.
 */
function open(text) {
  const link = tingLink(text);
  if (!link) return 'That is not a Ting link';
  const request = requestOf(link);
  stopScanning();
  if (INSIDE_ONLY.has(request)) {
    hold(link.trim());
    location.hash = INSIDE[request];
  } else {
    location.hash = `#${link}`;
  }
  return true;
}

/**
 * Opens the Ting link on the clipboard. The browser asks before it lets the
 * wallet read it, and some never do: then, or when the clipboard holds no
 * Ting link, the link is pasted into a field instead.
 */
export async function pasteLink() {
  let text = null;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Not allowed, or no clipboard to read here: the field below takes it.
  }
  // Copied text is anything at all: it counts as a link only when it asks for something Ting links ask.
  if (text && REQUESTS.has(requestOf(tingLink(text) ?? ''))) {
    const opened = open(text.trim());
    if (opened !== true) toast(opened);
    return;
  }
  const answer = await ask({
    title: 'Paste a link',
    text: text ? 'What you copied is not a Ting link. Paste the link here.' : '',
    fields: [{ name: 'link', label: 'Link', placeholder: 'ting:…', multiline: true }],
    confirm: 'Open',
  });
  const opened = answer && open(answer.link.trim());
  if (answer && opened !== true) toast(opened);
}

/** A reader of video frames: the browser's, or the wallet's own. */
async function reader() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
      }
    } catch {
      // fall through to the wallet's own decoder
    }
  }
  const { decodeQR } = await import('../qr-decode.js');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  // The square in the middle of the frame, where the guide is, at the
  // camera's own resolution: a long call link stays several pixels a module.
  return async (video) => {
    const side = Math.min(video.videoWidth, video.videoHeight);
    if (!side) return null;
    const size = Math.min(side, 1080);
    canvas.width = canvas.height = size;
    context.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, size, size);
    return decodeQR(context.getImageData(0, 0, size, size));
  };
}

export const scan = {
  render() {
    return `<section class="screen plain narrow">
      <h1 class="page">Scan a code</h1>
      <p class="lead">Point the camera at a Ting QR code, or paste a link someone sent you.</p>
      <div class="camera" data-camera>
        <video playsinline muted autoplay></video>
        <div class="frame" aria-hidden="true"></div>
        <div class="camera-note" data-note><span class="spinner"></span> Starting the camera…</div>
      </div>
      <p class="center muted small mt">Hold the phone 20–30 cm away, so the code fills about half the square.</p>
      <button class="btn secondary" data-paste>${icon('paste')} Paste a link</button>
    </section>`;
  },

  async bind(view) {
    stopScanning();
    addEventListener('hashchange', stopScanning, { once: true });
    $('[data-paste]', view).addEventListener('click', pasteLink);
    const note = $('[data-note]', view);
    const video = $('video', view);
    if (!navigator.mediaDevices?.getUserMedia) {
      note.innerHTML = `${icon('warn')} This browser cannot use the camera here. Paste the link instead.`;
      return;
    }
    const state = (running = { stop: false, stream: null });
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (e) {
      if (running === state) running = null;
      note.innerHTML = `${icon('warn')} ${esc(e?.name === 'NotAllowedError'
        ? 'The camera is not allowed for this site. Allow it in the browser’s settings, or paste the link.'
        : 'No camera could be opened. Paste the link instead.')}`;
      return;
    }
    if (state.stop || !view.isConnected) return stopScanning();
    video.srcObject = state.stream;
    await video.play().catch(() => {});
    let read;
    try {
      read = await reader();
    } catch {
      note.innerHTML = `${icon('warn')} Codes cannot be read in this browser yet. Paste the link instead.`;
      return;
    }
    note.hidden = true;
    let warned = false;
    while (!state.stop && view.isConnected) {
      if (video.readyState >= 2) {
        const text = await read(video).catch(() => null);
        if (state.stop) return;
        if (text) {
          const opened = open(text);
          if (opened === true) return;
          if (!warned) toast(opened);
          warned = true;
        }
      }
      await new Promise((r) => setTimeout(r, 180));
    }
    stopScanning();
  },
};
