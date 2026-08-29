// Redaction review panel. Adapted from RateMyVSO_Platform
// public/js/letter-safe-preview.js (see SYNC.md): rendering, the tap-a-word
// toggle, and copy behavior are byte-for-byte where possible. Changes:
//   - results arrive over the preload IPC bridge (window.api.redact), not
//     POST /api/chat/redact-preview (there is no server),
//   - the "Interpret" button is replaced by "Save redacted copy" (this app
//     redacts only; interpretation stays on the website on purpose).

(function () {
  'use strict';

  var REMOVED_LABELS = {
    SSN: 'Removed SSN', DOB: 'Removed DOB', 'FILE#': 'Removed File Number',
    ADDRESS: 'Removed Address', NAME: 'Removed Name', ID: 'Removed ID',
  };

  document.addEventListener('DOMContentLoaded', function () {
    var panel = document.getElementById('li-safe-preview');
    if (!panel) return;

    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function renderSampleTokens(text) {
      var pieces = String(text).split(/(\[(?:SSN|DOB|FILE#|ADDRESS|NAME|ID) REDACTED\])/g);
      var html = '';
      for (var i = 0; i < pieces.length; i++) {
        var p = pieces[i];
        if (p === '' || p == null) continue;
        var mk = p.match(/^\[(SSN|DOB|FILE#|ADDRESS|NAME|ID) REDACTED\]$/);
        if (mk) { html += '<span class="li-removed">' + esc(REMOVED_LABELS[mk[1]] || 'Removed') + '</span>'; continue; }
        p.replace(/(\s+)|([^\s]+)/g, function (whole, sep, word) {
          if (sep !== undefined) html += esc(sep);
          else html += '<span class="li-word" role="button" tabindex="0" aria-pressed="false" data-orig="' + esc(word) + '">' + esc(word) + '</span>';
          return whole;
        });
      }
      return html;
    }

    // The visible text IS exactly what gets saved / copied.
    function collectFinalText(container) { return container ? container.textContent : ''; }

    function close() { panel.hidden = true; panel.innerHTML = ''; }

    function wireClose() {
      var closeBtn = document.getElementById('li-safe-close');
      if (closeBtn) closeBtn.addEventListener('click', close);
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function renderLoading() {
      panel.innerHTML =
        '<div class="li-safe-box"><h3><span class="li-spinner" aria-hidden="true"></span><span>&#128274; Reading your file and removing personal details<span class="li-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></span></h3>' +
        '<p class="li-safe-intro">This runs entirely on this computer. A scanned PDF or photo can take up to a minute to read.</p></div>';
      panel.hidden = false;
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function renderError(msg) {
      panel.innerHTML =
        '<div class="li-safe-box"><h3>&#128274; Redaction</h3>' +
        '<p class="li-safe-intro err">' + esc(msg || 'Could not read the file.') + '</p>' +
        '<button type="button" class="btn" id="li-safe-close" style="margin-top:.85rem">Close</button></div>';
      panel.hidden = false;
      wireClose();
    }

    function fallbackCopy(text) {
      try {
        var t = document.createElement('textarea');
        t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
        document.body.appendChild(t); t.select();
        document.execCommand('copy'); document.body.removeChild(t);
      } catch (e) { /* ignore */ }
    }

    function renderResult(redactedText) {
      panel.innerHTML =
        '<div class="li-safe-box">' +
          '<h3>&#128274; Check the redacted copy</h3>' +
          '<p class="li-safe-intro">We removed the personal details we could detect (shown as labels like <em>Removed Name</em>). <strong>Tap any other word to remove every copy of it.</strong> Auto-redaction is a first pass, always check it yourself.</p>' +
          '<div class="li-safe-sample" id="li-safe-sample">' + renderSampleTokens(redactedText) + '</div>' +
          '<p class="li-safe-note">Only what you see here goes into the saved copy. Nothing has left this computer.</p>' +
          '<div class="li-safe-actions">' +
            '<button type="button" class="btn btn-green" id="li-safe-save-layout">Save redacted PDF (original layout)</button>' +
            '<button type="button" class="btn" id="li-safe-save">Save as text file</button>' +
            '<button type="button" class="btn" id="li-safe-save-pdf">Save as plain-text PDF</button>' +
            '<button type="button" class="btn" id="li-safe-copy">Copy redacted text</button>' +
            '<button type="button" class="btn" id="li-safe-close">Close</button>' +
          '</div>' +
        '</div>';
      panel.hidden = false;

      var sampleEl = document.getElementById('li-safe-sample');
      // Tap a word to remove EVERY copy of it; tap again to restore all.
      var coreOf = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
      var toggleWord = function (w) {
        var key = coreOf(w.getAttribute('data-orig'));
        if (!key) return;
        var removing = !w.classList.contains('li-removed');
        sampleEl.querySelectorAll('.li-word').forEach(function (x) {
          if (coreOf(x.getAttribute('data-orig')) !== key) return;
          if (removing) { x.classList.add('li-removed'); x.textContent = 'Removed Text'; }
          else { x.classList.remove('li-removed'); x.textContent = x.getAttribute('data-orig') || x.textContent; }
          x.setAttribute('aria-pressed', String(removing));
        });
      };
      if (sampleEl) sampleEl.addEventListener('click', function (e) {
        var w = e.target.closest && e.target.closest('.li-word');
        if (w) toggleWord(w);
      });
      if (sampleEl) sampleEl.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var w = e.target.closest && e.target.closest('.li-word');
        if (!w) return;
        e.preventDefault();
        toggleWord(w);
      });

      var copyBtn = document.getElementById('li-safe-copy');
      if (copyBtn) copyBtn.addEventListener('click', function () {
        var t = collectFinalText(sampleEl);
        var done = function () { copyBtn.textContent = 'Copied!'; setTimeout(function () { copyBtn.textContent = 'Copy redacted text'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t).then(done).catch(function () { fallbackCopy(t); done(); });
        } else { fallbackCopy(t); done(); }
      });

      var wireSave = function (id, fn, label) {
        var btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', function () {
          fn(collectFinalText(sampleEl)).then(function (r) {
            if (r && r.saved) {
              btn.textContent = 'Saved!';
              setTimeout(function () { btn.textContent = label; }, 1500);
              if (r.path) window.api.reveal(r.path);
            }
          });
        });
      };
      wireSave('li-safe-save', window.api.saveText, 'Save as text file');
      wireSave('li-safe-save-pdf', window.api.savePdf, 'Save as plain-text PDF');

      // Original-layout export: every auto-redacted span plus every tapped
      // word gets blacked out on the rasterized original pages (app.js).
      var layoutBtn = document.getElementById('li-safe-save-layout');
      if (layoutBtn) layoutBtn.addEventListener('click', function () {
        var tapped = [];
        sampleEl.querySelectorAll('.li-word.li-removed').forEach(function (x) {
          tapped.push(x.getAttribute('data-orig') || '');
        });
        layoutBtn.textContent = 'Building PDF...';
        window.exportLayoutPdf(tapped).then(function (r) {
          if (r && r.saved) {
            layoutBtn.textContent = 'Saved!';
            if (r.path) window.api.reveal(r.path);
          } else if (r && r.error) {
            layoutBtn.textContent = r.error;
          } else {
            layoutBtn.textContent = 'Save redacted PDF (original layout)';
            return;
          }
          setTimeout(function () { layoutBtn.textContent = 'Save redacted PDF (original layout)'; }, 3000);
        }).catch(function () {
          layoutBtn.textContent = 'Export failed';
          setTimeout(function () { layoutBtn.textContent = 'Save redacted PDF (original layout)'; }, 3000);
        });
      });
      wireClose();
    }

    async function runPreview(payload) {
      renderLoading();
      try {
        var data = await window.api.redact(payload);
        if (data && data.error) throw new Error(data.error);
        // The original-layout export (app.js) needs the auto-redacted spans
        // and the OCR layouts alongside the visible text.
        window.__redactMeta = { spans: (data && data.spans) || [], layouts: (data && data.layouts) || [] };
        renderResult((data && data.redacted_text) || '');
      } catch (err) {
        renderError(err.message);
      }
    }

    // Public API for app.js.
    window.LetterSafePreview = {
      previewFiles: function (files) { return runPreview({ files: files }); },
      previewText: function (text) { return runPreview({ text: text }); },
    };
  });
})();
