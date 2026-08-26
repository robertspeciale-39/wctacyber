// term.js — the terminal widget.
//
// A scrollback region plus a real <input>, so soft keyboards work on tablets
// and screen readers get a live log. `?` fires help on the keystroke, exactly
// as IOS does; Tab completes; --More-- pages long output.

export function createTerminal(root, opts = {}) {
  const scroll = root.querySelector('.term');
  const inputRow = root.querySelector('.term-input');
  const promptEl = inputRow.querySelector('.prompt');
  const input = inputRow.querySelector('input');

  const term = {
    root, scroll, input, promptEl,
    history: [], histIndex: -1, draft: '',
    paging: null,               // {lines, index}
    onSubmit: opts.onSubmit || (() => {}),
    onHelp: opts.onHelp || (() => []),
    onComplete: opts.onComplete || (l => ({ line: l })),
    getPrompt: opts.getPrompt || (() => '> '),
    masked: false,
    pageSize: opts.pageSize || 22
  };

  /* ------------------------------------------------------------ output --- */

  function write(text, cls) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text === '' ? ' ' : text;
    scroll.appendChild(line);
    return line;
  }

  term.write = (lines, cls) => {
    for (const l of [].concat(lines)) write(l, cls || classify(l));
    term.scrollToEnd();
  };

  /** Colour the lines IOS colours: errors, console messages. */
  function classify(l) {
    if (/^%\s*(Invalid|Ambiguous|Incomplete|Bad|Unrecognized)/.test(l)) return 'err';
    if (/^%[A-Z]/.test(l)) return 'sys';
    return null;
  }

  term.writeEcho = (prompt, line) => {
    const el = document.createElement('div');
    el.className = 'echo';
    const p = document.createElement('span');
    p.className = 'p';
    p.textContent = prompt;
    el.append(p, document.createTextNode(line));
    scroll.appendChild(el);
    term.scrollToEnd();
  };

  term.clear = () => { scroll.replaceChildren(); };

  term.scrollToEnd = () => { scroll.scrollTop = scroll.scrollHeight; };

  /* ------------------------------------------------------------ paging --- */
  // Long output stops at --More--. Space pages, Enter gives one line, q quits.
  // This is a real skill: `show running-config` does it on every device.

  function startPaging(lines) {
    term.paging = { lines, index: 0 };
    emitPage(term.pageSize);
  }

  function emitPage(n) {
    const p = term.paging;
    const slice = p.lines.slice(p.index, p.index + n);
    for (const l of slice) write(l, classify(l));
    p.index += slice.length;
    if (p.index >= p.lines.length) {
      term.paging = null;
      inputRow.style.display = '';
      renderPrompt();
    } else {
      write(' --More-- ', 'more');
      inputRow.style.display = 'none';
    }
    term.scrollToEnd();
  }

  term.output = (lines) => {
    const arr = [].concat(lines || []);
    if (arr.length > term.pageSize + 4) { startPaging(arr); return; }
    term.write(arr);
  };

  /* ------------------------------------------------------------ prompt --- */

  function renderPrompt() {
    promptEl.textContent = term.getPrompt();
    input.type = term.masked ? 'password' : 'text';
  }
  term.refresh = renderPrompt;
  term.setMasked = v => { term.masked = !!v; renderPrompt(); };
  term.focus = () => input.focus({ preventScroll: true });

  /* ------------------------------------------------------------- input --- */

  root.addEventListener('mouseup', () => {
    if (!window.getSelection().toString()) term.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (!term.paging) return;
    if (e.key === ' ') { e.preventDefault(); emitPage(term.pageSize); }
    else if (e.key === 'Enter') { e.preventDefault(); emitPage(1); }
    else if (e.key === 'q' || e.key === 'Escape') {
      e.preventDefault();
      term.paging = null;
      inputRow.style.display = '';
      renderPrompt();
      term.focus();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = input.value;
      term.writeEcho(term.getPrompt(), term.masked ? '' : line);
      input.value = '';
      if (line.trim() && !term.masked) {
        term.history.push(line);
        if (term.history.length > 100) term.history.shift();
      }
      term.histIndex = -1;
      term.onSubmit(line);
      renderPrompt();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const res = term.onComplete(input.value);
      if (res.lines) {
        term.writeEcho(term.getPrompt(), input.value);
        term.write(res.lines);
      }
      input.value = res.line;
      return;
    }

    if (e.key === '?' && !term.masked) {
      e.preventDefault();
      const line = input.value;
      term.writeEcho(term.getPrompt(), line + '?');
      term.write(term.onHelp(line));
      // IOS reprints what you had typed so you can keep going.
      renderPrompt();
      input.value = line;
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!term.history.length) return;
      if (term.histIndex === -1) { term.draft = input.value; term.histIndex = term.history.length; }
      term.histIndex = Math.max(0, term.histIndex - 1);
      input.value = term.history[term.histIndex];
      queueMicrotask(() => input.setSelectionRange(input.value.length, input.value.length));
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (term.histIndex === -1) return;
      term.histIndex++;
      if (term.histIndex >= term.history.length) {
        term.histIndex = -1;
        input.value = term.draft;
      } else {
        input.value = term.history[term.histIndex];
      }
      return;
    }

    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      term.writeEcho(term.getPrompt(), input.value + '^C');
      input.value = '';
      opts.onBreak && opts.onBreak();
      return;
    }

    if (e.key === 'z' && e.ctrlKey) {
      e.preventDefault();
      input.value = '';
      opts.onEnd && opts.onEnd();
      renderPrompt();
      return;
    }

    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      term.clear();
      return;
    }
  });

  renderPrompt();
  return term;
}
