// Browser source of the embeddable "Feature requests" widget, served verbatim by the
// resource route at /tools/feature-requests/embed.js. Plain ES2017, no build step, no
// dependencies; everything renders inside a Shadow DOM root so host-page CSS cannot leak
// in or out. Do not use backticks or "${" inside the script: it is a String.raw template.

export const EMBED_SCRIPT_VERSION = "4";

export const EMBED_SCRIPT: string = String.raw`(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;

  var SCRIPT_PATH = "/tools/feature-requests/embed.js";
  var DEFAULT_ACCENT = "#f5a524";
  var STORAGE_KEY = "devforge-fr-voter";
  var STATUS = { planned: "Planned", in_progress: "In progress", done: "Done" };

  // Find our own <script> tag (currentScript is null when re-run or loaded as a module).
  var script = document.currentScript;
  if (!script || !script.src || script.src.indexOf(SCRIPT_PATH) === -1) {
    script = null;
    var tags = document.querySelectorAll("script[src]");
    for (var t = tags.length - 1; t >= 0; t--) {
      if (tags[t].src.indexOf(SCRIPT_PATH) !== -1) { script = tags[t]; break; }
    }
  }
  if (!script) return;

  // Never mount twice for the same tag.
  var registry = (window.__devforgeFeatureRequests = window.__devforgeFeatureRequests || []);
  if (registry.indexOf(script) !== -1) return;
  registry.push(script);

  var projectId = (script.getAttribute("data-project") || "").trim();
  if (!projectId) {
    if (window.console) console.warn("[feature-requests] data-project is missing");
    return;
  }
  var base = script.src.split("#")[0].split("?")[0].replace(/\/embed\.js$/, "");
  var mode = script.getAttribute("data-mode") === "inline" ? "inline" : "floating";
  var label = script.getAttribute("data-label") || "Feature requests";
  var position = script.getAttribute("data-position") === "left" ? "left" : "right";
  var theme = script.getAttribute("data-theme") === "light" ? "light" : "dark";
  var targetSelector = script.getAttribute("data-target") || "";
  var accent = validHex(script.getAttribute("data-color"));

  function validHex(v) {
    v = (v || "").trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : "";
  }

  // Readable text colour on top of the accent.
  function onAccent(hex) {
    var h = hex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#111111" : "#ffffff";
  }

  var memoryVoter = "";
  function randomKey() {
    var bytes = new Uint8Array(20);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.random() * 256;
    return Array.prototype.map.call(bytes, function (b) { return (b % 36).toString(36); }).join("");
  }
  var EMAIL_KEY = "devforge-fr-email";
  function storedEmail() {
    try { return (localStorage.getItem(EMAIL_KEY) || "").trim(); } catch (e) { return ""; }
  }
  function rememberEmail(v) {
    try { localStorage.setItem(EMAIL_KEY, v); } catch (e) { /* private mode */ }
  }

  function voterKey() {
    var key = "";
    try { key = window.localStorage.getItem(STORAGE_KEY) || ""; } catch (e) {}
    if (!key) {
      key = memoryVoter || randomKey();
      memoryVoter = key;
      try { window.localStorage.setItem(STORAGE_KEY, key); } catch (e) {}
    }
    return key;
  }

  function api(method, path, body) {
    return fetch(base + path, {
      method: method,
      mode: "cors",
      credentials: "omit",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok && data && data.ok) return data;
        var err = new Error(res.status === 429
          ? "Too many requests, try again in a minute"
          : (data && data.error) || "Something went wrong (" + res.status + ")");
        err.status = res.status;
        throw err;
      });
    }, function () {
      throw new Error("Could not reach the server. Check your connection and try again.");
    });
  }

  // Tiny DOM builder. User content only ever goes through textContent.
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "text") node.textContent = attrs[k];
      else if (k === "className") node.className = attrs[k];
      else if (k.indexOf("on") === 0) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    }
    for (var i = 0; children && i < children.length; i++) if (children[i]) node.appendChild(children[i]);
    return node;
  }

  function setMsg(node, text, kind) {
    node.textContent = text;
    node.className = "fr-msg" + (kind ? " " + kind : "");
    node.hidden = !text;
  }

  var UP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var CSS = [
    ":host{all:initial;display:block}",
    "*,*::before,*::after{box-sizing:border-box}",
    "[hidden]{display:none!important}",
    "p{margin:0}",
    ".fr{font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased;text-align:left}",
    ".fr.dark{--bg:#0c0c0e;--fg:rgba(255,255,255,.85);--muted:rgba(255,255,255,.55);--border:rgba(255,255,255,.1);--field:rgba(255,255,255,.06);--shadow:0 20px 60px rgba(0,0,0,.5)}",
    ".fr.light{--bg:#fff;--fg:rgba(0,0,0,.85);--muted:rgba(0,0,0,.55);--border:rgba(0,0,0,.1);--field:rgba(0,0,0,.04);--shadow:0 20px 60px rgba(0,0,0,.18)}",
    "button,input,textarea{font:inherit;color:inherit;margin:0}",
    "button{cursor:pointer;border:0;background:none;padding:0}",
    "button:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
    ".fr-launch{position:fixed;bottom:20px;z-index:2147483000;padding:10px 18px;border-radius:999px;background:var(--accent);color:var(--on-accent);font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.3)}",
    ".right .fr-launch,.right .fr-panel{right:20px}.left .fr-launch,.left .fr-panel{left:20px}",
    ".fr-panel{position:fixed;bottom:76px;z-index:2147483001;width:min(420px,calc(100vw - 40px));max-height:min(640px,calc(100vh - 100px));display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);overflow:hidden;outline:none}",
    "@media (max-width:520px){.fr-panel{top:0;right:0;bottom:0;left:0;width:auto;max-height:none;border-radius:0;border:0}}",
    ".fr-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border)}",
    ".fr-title{font-size:15px;font-weight:600}",
    ".fr-x{width:32px;height:32px;border-radius:8px;color:var(--muted);font-size:20px;line-height:1}",
    ".fr-x:hover{background:var(--field);color:var(--fg)}",
    ".fr-tabs{display:flex;gap:4px;padding:6px 12px 0;border-bottom:1px solid var(--border)}",
    ".fr-tab{padding:8px 12px;color:var(--muted);font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px}",
    ".fr-tab:hover,.fr-tab[aria-selected=true]{color:var(--fg)}.fr-tab[aria-selected=true]{border-bottom-color:var(--accent)}",
    ".fr-body{overflow:auto;padding:16px;flex:1 1 auto}",
    ".fr-foot{padding:8px 16px;border-top:1px solid var(--border);font-size:11px;color:var(--muted);text-align:center}",
    ".fr-foot a{color:inherit;text-decoration:none}.fr-foot a:hover{color:var(--fg)}",
    ".fr-intro{color:var(--muted);font-size:13px;margin-bottom:12px}",
    ".fr-list{list-style:none;margin:0;padding:0}",
    ".fr-row{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)}.fr-row:last-child{border-bottom:0}",
    ".fr-vote{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;min-width:44px;align-self:flex-start;padding:6px 4px;border-radius:8px;border:1px solid var(--border);background:var(--field);color:var(--muted);font-size:12px;font-weight:600;line-height:1.2}",
    ".fr-vote:hover{border-color:var(--accent);color:var(--fg)}",
    ".fr-vote[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}",
    ".fr-vote svg{width:14px;height:14px;display:block;margin-bottom:2px}",
    ".fr-main{flex:1 1 auto;min-width:0}",
    ".fr-row-title{font-weight:600;margin-bottom:2px;overflow-wrap:anywhere}",
    ".fr-chip{display:inline-block;margin-left:8px;vertical-align:1px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:600;background:var(--field);color:var(--muted);border:1px solid var(--border)}",
    ".fr-chip.in_progress{color:var(--accent);border-color:var(--accent)}.fr-chip.done{color:#3fb950;border-color:rgba(63,185,80,.45)}",
    ".fr-details{color:var(--muted);font-size:13px;white-space:pre-line;overflow-wrap:anywhere}",
    ".fr-details.clamped{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
    ".fr-more{color:var(--accent);font-size:12px;font-weight:500;margin-top:2px}",
    ".fr-field{display:block;margin-bottom:12px}",
    ".fr-field span{display:block;font-size:12px;font-weight:500;color:var(--muted);margin-bottom:4px}",
    ".fr-input{width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--border);background:var(--field);color:var(--fg);font-size:14px}",
    ".fr-input::placeholder{color:var(--muted);opacity:1}",
    "textarea.fr-input{min-height:88px;resize:vertical}",
    ".fr-primary{padding:9px 16px;border-radius:8px;background:var(--accent);color:var(--on-accent);font-weight:600}",
    ".fr-primary[disabled]{opacity:.6;cursor:default}",
    ".fr-ghost{margin-top:10px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);color:var(--fg);font-weight:500}",
    ".fr-msg{margin-top:10px;font-size:13px;color:var(--muted)}.fr-msg.err{color:#f87171}.fr-msg.ok{color:#3fb950}",
    ".fr-email-ask{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:10px 0;font-size:13px;color:var(--muted)}.fr-email-ask .fr-input{flex:1;min-width:140px}",
    ".fr-state{padding:24px 0;text-align:center;color:var(--muted);font-size:13px}",
    ".fr-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;opacity:0}",
    ".fr-section{margin-bottom:24px}",
    ".fr-h{font-size:16px;font-weight:600;margin-bottom:10px}",
    ".fr-row-btn{display:block;width:100%;text-align:left}.fr-row-btn:hover .fr-row-title{color:var(--accent)}",
    ".fr-back{display:inline-flex;align-items:center;color:var(--muted);font-size:13px;font-weight:500;margin-bottom:12px}.fr-back:hover{color:var(--fg)}",
    ".fr-detail-title{font-size:17px;font-weight:600;overflow-wrap:anywhere}",
    ".fr-detail-meta{color:var(--muted);font-size:12px;margin:2px 0 10px}",
    ".fr-detail-body{display:flex;gap:12px}",
    ".fr-open{display:inline-block;margin-top:10px;color:var(--accent);font-size:12px;font-weight:500;text-decoration:none}.fr-open:hover{text-decoration:underline}",
    ".fr-edit-actions{display:flex;gap:8px;margin-top:8px}",
    ".fr-editor textarea.fr-input{min-height:140px;margin-top:10px}"
  ].join("\n");

  var state = { project: null, requests: [], loaded: false };

  // ---- Board: the list of requests ----
  function createBoard(onLoaded) {
    var intro = el("p", { className: "fr-intro" });
    intro.hidden = true;
    var stateEl = el("div", { className: "fr-state" });
    var notice = el("p", { className: "fr-msg err", role: "alert" });
    notice.hidden = true;
    var list = el("ul", { className: "fr-list" });
    // Votes belong to a person: this one-line form appears the first time
    // someone votes without a remembered email, then stays out of the way.
    var emailAskInput = el("input", { className: "fr-input", type: "email", placeholder: "you@example.com", autocomplete: "email" });
    var emailAskSave = el("button", { className: "fr-primary", type: "submit", text: "Save" });
    var emailAsk = el("form", { className: "fr-email-ask", novalidate: "" }, [
      el("span", { text: "Enter your email to vote" }),
      emailAskInput,
      emailAskSave
    ]);
    emailAsk.hidden = true;
    var emailAskPending = null;
    emailAsk.addEventListener("submit", function (e) {
      e.preventDefault();
      var value = emailAskInput.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        flash("Enter your email address to vote.");
        emailAskInput.focus();
        return;
      }
      rememberEmail(value);
      emailAsk.hidden = true;
      var run = emailAskPending;
      emailAskPending = null;
      if (run) run();
    });
    function askEmailInline(pending) {
      emailAskPending = pending;
      emailAsk.hidden = false;
      emailAskInput.focus();
    }
    var detailWrap = el("div", { className: "fr-detail" });
    detailWrap.hidden = true;
    var wrap = el("div", {}, [intro, stateEl, notice, emailAsk, list, detailWrap]);
    var noticeTimer;

    function flash(text) {
      setMsg(notice, text, "err");
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(function () { notice.hidden = true; }, 4000);
    }

    function showState(text, retry) {
      stateEl.textContent = "";
      stateEl.hidden = !text;
      if (text) stateEl.appendChild(el("div", { text: text }));
      if (retry) stateEl.appendChild(el("button", { className: "fr-ghost", type: "button", text: "Retry", onclick: load }));
    }

    function paintVote(btn, r) {
      btn.setAttribute("aria-pressed", r.voted ? "true" : "false");
      btn.setAttribute("aria-label", (r.voted ? "Remove upvote: " : "Upvote: ") + r.title);
      btn.lastChild.textContent = String(Number(r.votes) || 0);
    }

    function toggleVote(r, btn) {
      if (r.pending) return;
      if (!storedEmail()) {
        askEmailInline(function () { toggleVote(r, btn); });
        return;
      }
      r.pending = true;
      var wasVoted = !!r.voted, wasVotes = Number(r.votes) || 0;
      r.voted = !wasVoted;
      r.votes = wasVotes + (r.voted ? 1 : -1);
      paintVote(btn, r);
      api("POST", "/api/requests/" + encodeURIComponent(r.id) + "/vote", { voter: voterKey(), email: storedEmail() })
        .then(function (d) {
          if (typeof d.votes === "number") r.votes = d.votes;
          if (typeof d.voted === "boolean") r.voted = d.voted;
          paintVote(btn, r);
        }, function (err) {
          r.voted = wasVoted;
          r.votes = wasVotes;
          paintVote(btn, r);
          flash(err.message);
        })
        .then(function () { r.pending = false; });
    }

    // ---- Detail view: one request, full page style, inside the widget ----
    function detailUrl(r) {
      return base + "/p/" + encodeURIComponent(projectId) + "/r/" + encodeURIComponent(r.id);
    }

    function showList() {
      detailWrap.hidden = true;
      detailWrap.textContent = "";
      list.hidden = false;
      if (state.project && state.project.intro) intro.hidden = false;
      render();
    }

    function showDetail(r) {
      list.hidden = true;
      intro.hidden = true;
      stateEl.hidden = true;
      detailWrap.hidden = false;
      paintDetail(r, null);
      // Fresh copy plus the edit claim (server-checked email match).
      api("GET", "/api/requests/" + encodeURIComponent(r.id) + "?voter=" + encodeURIComponent(voterKey()) + (storedEmail() ? "&email=" + encodeURIComponent(storedEmail()) : ""))
        .then(function (d) {
          if (d.request) {
            r.title = d.request.title;
            r.details = d.request.details;
            r.status = d.request.status;
            r.votes = d.request.votes;
            r.voted = d.request.voted;
          }
          if (!detailWrap.hidden) paintDetail(r, d.canEdit === true);
        }, function () {
          if (!detailWrap.hidden) paintDetail(r, false);
        });
    }

    function paintDetail(r, canEdit) {
      detailWrap.textContent = "";
      detailWrap.appendChild(el("button", { className: "fr-back", type: "button", text: "\u2190 All requests", onclick: showList }));
      var vote = el("button", { className: "fr-vote", type: "button" });
      vote.innerHTML = UP_ICON;
      vote.appendChild(el("span"));
      paintVote(vote, r);
      vote.addEventListener("click", function () { toggleVote(r, vote); });
      var title = el("p", { className: "fr-detail-title", text: r.title || "" });
      if (STATUS[r.status]) title.appendChild(el("span", { className: "fr-chip " + r.status, text: STATUS[r.status] }));
      var main = el("div", { className: "fr-main" }, [title]);
      if (r.createdAt) main.appendChild(el("p", { className: "fr-detail-meta", text: new Date(r.createdAt).toLocaleDateString() }));
      if (r.details) main.appendChild(el("p", { className: "fr-details", text: r.details }));
      main.appendChild(el("a", { className: "fr-open", href: detailUrl(r), target: "_blank", rel: "noopener", text: "Open full page" }));
      if (canEdit) {
        var editBtn = el("button", { className: "fr-ghost", type: "button", text: "Edit details" });
        var editor = el("div", { className: "fr-editor" });
        editor.hidden = true;
        var ta = el("textarea", { className: "fr-input", maxlength: "5000", "aria-label": "Details" });
        ta.value = r.details || "";
        var emsg = el("p", { className: "fr-msg", role: "status", "aria-live": "polite" });
        emsg.hidden = true;
        var save = el("button", { className: "fr-primary", type: "button", text: "Save" });
        var cancel = el("button", { className: "fr-ghost", type: "button", text: "Cancel", onclick: function () { editor.hidden = true; editBtn.hidden = false; } });
        save.addEventListener("click", function () {
          save.disabled = true;
          setMsg(emsg, "Saving...", "");
          api("POST", "/api/requests/" + encodeURIComponent(r.id), { email: storedEmail(), voter: voterKey(), details: ta.value })
            .then(function (d) {
              if (d.request) r.details = d.request.details;
              paintDetail(r, true);
            }, function (err) {
              save.disabled = false;
              setMsg(emsg, err.message, "err");
            });
        });
        editBtn.addEventListener("click", function () { editBtn.hidden = true; editor.hidden = false; ta.focus(); });
        editor.appendChild(ta);
        editor.appendChild(el("div", { className: "fr-edit-actions" }, [save, cancel]));
        editor.appendChild(emsg);
        main.appendChild(editBtn);
        main.appendChild(editor);
      }
      detailWrap.appendChild(el("div", { className: "fr-detail-body" }, [vote, main]));
    }

    function row(r) {
      var vote = el("button", { className: "fr-vote", type: "button" });
      vote.innerHTML = UP_ICON;
      vote.appendChild(el("span"));
      paintVote(vote, r);
      vote.addEventListener("click", function () { toggleVote(r, vote); });
      var title = el("p", { className: "fr-row-title", text: r.title || "" });
      if (STATUS[r.status]) title.appendChild(el("span", { className: "fr-chip " + r.status, text: STATUS[r.status] }));
      var openBtn = el("button", { className: "fr-row-btn", type: "button" }, [title]);
      openBtn.addEventListener("click", function () { showDetail(r); });
      var main = el("div", { className: "fr-main" }, [openBtn]);
      if (r.details) {
        var long = r.details.length > 140 || r.details.indexOf("\n") !== -1;
        var details = el("p", { className: "fr-details" + (long ? " clamped" : ""), text: r.details });
        main.appendChild(details);
        if (long) {
          var more = el("button", { className: "fr-more", type: "button", text: "Read more" });
          more.addEventListener("click", function () { showDetail(r); });
          main.appendChild(more);
        }
      }
      return el("li", { className: "fr-row" }, [vote, main]);
    }

    function render() {
      list.textContent = "";
      showState(state.requests.length ? "" : "No requests yet. Be the first to suggest one.");
      for (var i = 0; i < state.requests.length; i++) list.appendChild(row(state.requests[i]));
    }

    function load() {
      showState("Loading requests...");
      list.textContent = "";
      notice.hidden = true;
      api("GET", "/api/projects/" + encodeURIComponent(projectId) + "/board?voter=" + encodeURIComponent(voterKey()) + (storedEmail() ? "&email=" + encodeURIComponent(storedEmail()) : ""))
        .then(function (data) {
          state.project = data.project || {};
          state.requests = Array.isArray(data.requests) ? data.requests : [];
          state.loaded = true;
          if (state.project.intro) { intro.textContent = state.project.intro; intro.hidden = false; }
          render();
          onLoaded(state.project);
        }, function (err) {
          showState(err.message, true);
          onLoaded(null);
        });
    }

    return {
      el: wrap,
      load: load,
      prepend: function (r) { state.requests.unshift(r); render(); }
    };
  }

  // ---- Suggest form ----
  function createForm(onCreated) {
    var titleIn = el("input", { className: "fr-input", type: "text", maxlength: "120", placeholder: "Short summary of the idea", autocomplete: "off" });
    var detailsIn = el("textarea", { className: "fr-input", maxlength: "5000", placeholder: "What problem would it solve? Any context helps." });
    var emailIn = el("input", { className: "fr-input", type: "email", placeholder: "you@example.com", autocomplete: "email", required: "" });
    // Honeypot: visually hidden, never prefilled, always sent.
    var hp = el("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
    var msg = el("p", { className: "fr-msg", role: "status", "aria-live": "polite" });
    msg.hidden = true;
    var submit = el("button", { className: "fr-primary", type: "submit", text: "Submit request" });
    var busy = false;

    function field(text, input) {
      return el("label", { className: "fr-field" }, [el("span", { text: text }), input]);
    }

    var form = el("form", { novalidate: "" }, [
      field("Title", titleIn),
      field("Details (optional)", detailsIn),
      field("Email (required, we send a verification code)", emailIn),
      el("div", { className: "fr-hp", "aria-hidden": "true" }, [hp]),
      submit,
      msg
    ]);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (busy) return;
      var title = titleIn.value.trim();
      if (title.length < 3 || title.length > 120) {
        setMsg(msg, "Title must be between 3 and 120 characters.", "err");
        titleIn.focus();
        return;
      }
      var email = emailIn.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setMsg(msg, "Enter your email address so we can verify it.", "err");
        emailIn.focus();
        return;
      }
      busy = true;
      submit.disabled = true;
      setMsg(msg, "Sending...", "");
      api("POST", "/api/projects/" + encodeURIComponent(projectId) + "/requests", {
        title: title,
        details: detailsIn.value.trim(),
        email: email,
        voter: voterKey(),
        website: hp.value
      }).then(function (data) {
        rememberEmail(email);
        form.reset();
        if (data.verificationSent) {
          setMsg(msg, "Thanks, your request has been added. We emailed " + email + " a verification code.", "ok");
        } else {
          setMsg(msg, "Thanks, your request has been added.", "ok");
        }
        if (data.request) onCreated(data.request);
      }, function (err) {
        setMsg(msg, err.message, "err");
      }).then(function () {
        busy = false;
        submit.disabled = false;
      });
    });
    return form;
  }

  function footer() {
    return el("div", { className: "fr-foot" }, [
      el("a", { href: "https://devforge.io/tools/feature-requests", target: "_blank", rel: "noopener", text: "Powered by Devforge" })
    ]);
  }

  function createRoot(extraClass) {
    var host = document.createElement("div");
    host.setAttribute("data-devforge-feature-requests", projectId);
    var shadow = host.attachShadow({ mode: "open" });
    shadow.appendChild(el("style", { text: CSS }));
    var root = el("div", { className: "fr " + theme + " " + extraClass });
    shadow.appendChild(root);
    return { host: host, shadow: shadow, root: root };
  }

  function applyAccent(root, project) {
    var hex = accent || (project && validHex(project.accent)) || DEFAULT_ACCENT;
    root.style.setProperty("--accent", hex);
    root.style.setProperty("--on-accent", onAccent(hex));
  }

  // ---- Inline mode: form on top, board below, inside the target element ----
  function mountInline() {
    var target = targetSelector ? document.querySelector(targetSelector) : null;
    if (!target) {
      if (window.console) console.warn("[feature-requests] data-target not found: " + targetSelector);
      return;
    }
    var r = createRoot("fr-inline");
    applyAccent(r.root, null);
    var boardSection;
    var board = createBoard(function (project) {
      if (!project) return;
      applyAccent(r.root, project);
      boardSection.hidden = project.boardEnabled === false;
    });
    var form = createForm(board.prepend);
    boardSection = el("section", { className: "fr-section" }, [el("h2", { className: "fr-h", text: "Requests" }), board.el]);
    r.root.appendChild(el("section", { className: "fr-section" }, [el("h2", { className: "fr-h", text: "Suggest a feature" }), form]));
    r.root.appendChild(boardSection);
    r.root.appendChild(footer());
    target.appendChild(r.host);
    board.load();
  }

  // ---- Floating mode: pill button plus a tabbed panel ----
  function mountFloating() {
    var r = createRoot(position);
    applyAccent(r.root, null);
    var boardEnabled = true;
    var board = createBoard(function (project) {
      if (project) {
        applyAccent(r.root, project);
        if (project.name) titleEl.textContent = project.name;
        boardEnabled = project.boardEnabled !== false;
      }
      tabs.hidden = !boardEnabled;
      if (!boardEnabled) setTab("suggest");
    });
    var form = createForm(board.prepend);

    var launch = el("button", { className: "fr-launch", type: "button", text: label, "aria-haspopup": "dialog", "aria-expanded": "false" });
    var titleEl = el("div", { className: "fr-title", text: label });
    var closeBtn = el("button", { className: "fr-x", type: "button", "aria-label": "Close", text: "×", onclick: close });
    var tabReq = el("button", { className: "fr-tab", type: "button", role: "tab", text: "Requests", onclick: function () { setTab("requests"); } });
    var tabSug = el("button", { className: "fr-tab", type: "button", role: "tab", text: "Suggest", onclick: function () { setTab("suggest"); } });
    var tabs = el("div", { className: "fr-tabs", role: "tablist" }, [tabReq, tabSug]);
    tabs.hidden = true;
    var paneReq = el("div", { role: "tabpanel" }, [board.el]);
    var paneSug = el("div", { role: "tabpanel" }, [form]);
    var body = el("div", { className: "fr-body" }, [paneReq, paneSug]);
    var panel = el("div", { className: "fr-panel", role: "dialog", "aria-modal": "true", "aria-label": label, tabindex: "-1" }, [
      el("div", { className: "fr-head" }, [titleEl, closeBtn]),
      tabs,
      body,
      footer()
    ]);
    panel.hidden = true;
    r.root.appendChild(launch);
    r.root.appendChild(panel);

    function setTab(name) {
      var req = name === "requests";
      tabReq.setAttribute("aria-selected", req ? "true" : "false");
      tabSug.setAttribute("aria-selected", req ? "false" : "true");
      paneReq.hidden = !req;
      paneSug.hidden = req;
      body.scrollTop = 0;
    }
    setTab("requests");

    function onDocKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    }
    function onDocPointer(e) {
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(panel) === -1 && path.indexOf(launch) === -1) close();
    }
    // Keep Tab focus inside the open panel.
    panel.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var all = panel.querySelectorAll("button,input,textarea,a[href]"), f = [];
      for (var i = 0; i < all.length; i++) {
        if (!all[i].disabled && all[i].tabIndex !== -1 && all[i].offsetParent !== null) f.push(all[i]);
      }
      if (!f.length) return;
      var cur = r.shadow.activeElement;
      if (e.shiftKey && (cur === f[0] || cur === panel)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && cur === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });

    function open() {
      if (!panel.hidden) return;
      panel.hidden = false;
      launch.setAttribute("aria-expanded", "true");
      if (!state.loaded) board.load();
      panel.focus();
      document.addEventListener("keydown", onDocKey);
      document.addEventListener("pointerdown", onDocPointer, true);
    }
    function close() {
      if (panel.hidden) return;
      panel.hidden = true;
      launch.setAttribute("aria-expanded", "false");
      document.removeEventListener("keydown", onDocKey);
      document.removeEventListener("pointerdown", onDocPointer, true);
      launch.focus();
    }
    launch.addEventListener("click", function () { if (panel.hidden) open(); else close(); });

    document.body.appendChild(r.host);
  }

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    try {
      if (mode === "inline") mountInline();
      else mountFloating();
    } catch (e) {
      if (window.console) console.error("[feature-requests] failed to mount", e);
    }
  });
})();
`;
