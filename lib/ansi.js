// Parse herdr `pane.read format:"ansi"` output into styled row spans.
//
// herdr's ANSI reads contain ONLY SGR sequences (ESC[...m) and \r\n line
// separators — no cursor movement (verified empirically, see
// docs/socket-api-notes.md). So parsing is a simple per-line SGR state
// machine; style state carries across lines within one read.
//
// Span shape (kept compact for the wire):
//   { t: "text", f: fg, g: bg, m: mask }
// f/g: null | "aN" (ansi 0-15) | "xN" (256-palette) | "#rrggbb"
// mask bits: 1=bold 2=dim 4=italic 8=underline 16=reverse 32=strike
'use strict';

const SGR_RE = /\x1b\[([0-9;]*)m/;

function emptyStyle() {
  return { f: null, g: null, m: 0 };
}

function applySgr(style, paramsStr) {
  const params = paramsStr === '' ? [0] : paramsStr.split(';').map((p) => (p === '' ? 0 : parseInt(p, 10)));
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) { style.f = null; style.g = null; style.m = 0; }
    else if (p === 1) style.m |= 1;
    else if (p === 2) style.m |= 2;
    else if (p === 3) style.m |= 4;
    else if (p === 4) style.m |= 8;
    else if (p === 7) style.m |= 16;
    else if (p === 9) style.m |= 32;
    else if (p === 21 || p === 22) style.m &= ~3;
    else if (p === 23) style.m &= ~4;
    else if (p === 24) style.m &= ~8;
    else if (p === 27) style.m &= ~16;
    else if (p === 29) style.m &= ~32;
    else if (p >= 30 && p <= 37) style.f = `a${p - 30}`;
    else if (p === 39) style.f = null;
    else if (p >= 40 && p <= 47) style.g = `a${p - 40}`;
    else if (p === 49) style.g = null;
    else if (p >= 90 && p <= 97) style.f = `a${p - 90 + 8}`;
    else if (p >= 100 && p <= 107) style.g = `a${p - 100 + 8}`;
    else if (p === 38 || p === 48) {
      const target = p === 38 ? 'f' : 'g';
      if (params[i + 1] === 5 && params.length > i + 2) {
        style[target] = `x${params[i + 2]}`;
        i += 2;
      } else if (params[i + 1] === 2 && params.length > i + 4) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
        style[target] = `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
        i += 4;
      }
    }
    // Unknown SGR params are ignored.
  }
}

// text: one herdr ansi read (lines separated by \r\n or \n).
// Returns rows: Array<Array<span>>.
function parseAnsiScreen(text) {
  const style = emptyStyle();
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const spans = [];
    let rest = line.replace(/\r/g, '');
    while (rest.length > 0) {
      const match = SGR_RE.exec(rest);
      if (!match) {
        pushSpan(spans, rest, style);
        break;
      }
      if (match.index > 0) pushSpan(spans, rest.slice(0, match.index), style);
      applySgr(style, match[1]);
      rest = rest.slice(match.index + match[0].length);
    }
    rows.push(spans);
  }
  return rows;
}

function pushSpan(spans, text, style) {
  // Strip any non-SGR escapes defensively (shouldn't occur per recon).
  text = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b./g, '');
  if (!text) return;
  const last = spans[spans.length - 1];
  if (last && last.f === style.f && last.g === style.g && last.m === style.m) {
    last.t += text;
  } else {
    spans.push({ t: text, f: style.f, g: style.g, m: style.m });
  }
}

module.exports = { parseAnsiScreen };
