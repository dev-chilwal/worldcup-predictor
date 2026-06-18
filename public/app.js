/* =====================================================================
   World Cup Predictor — frontend logic (vanilla JS, no build step)
   Reads window.SUPABASE_URL / window.SUPABASE_ANON_KEY from config.js.
   ===================================================================== */
(function () {
  "use strict";

  // ---------- DOM helpers ----------
  var $ = function (id) {
    return document.getElementById(id);
  };
  function show(el) {
    el && el.classList.remove("hidden");
  }
  function hide(el) {
    el && el.classList.add("hidden");
  }
  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------- Toast ----------
  function toast(message, kind) {
    var wrap = $("toast-wrap");
    if (!wrap) return;
    var t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = message;
    wrap.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity .25s";
      t.style.opacity = "0";
      setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, 260);
    }, 2600);
  }

  // ---------- Config guard ----------
  var SYNTH_DOMAIN = "guest.worldcupgolazo.app";
  var URL = window.SUPABASE_URL;
  var KEY = window.SUPABASE_ANON_KEY;
  var GROUP_CODE = window.GROUP_CODE;
  var configured =
    typeof URL === "string" &&
    typeof KEY === "string" &&
    typeof GROUP_CODE === "string" &&
    GROUP_CODE.length > 0 &&
    URL.indexOf("YOUR-PROJECT") === -1 &&
    KEY.indexOf("YOUR-ANON") === -1 &&
    /^https?:\/\//.test(URL) &&
    KEY.length > 10;

  if (!configured) {
    show($("config-warn"));
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    show($("config-warn"));
    $("config-warn").querySelector("h2").textContent =
      "Could not load Supabase";
    $("config-warn").querySelector("p").textContent =
      "The Supabase library failed to load from the CDN. Check your internet connection and reload.";
    return;
  }

  var sb = window.supabase.createClient(URL, KEY, {
    auth: {
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  // ---------- App state ----------
  var state = {
    user: null,
    profile: null,
    matches: [],
    predsByMatch: {}, // match_id -> prediction row
    activeTab: "fixtures",
    selectedDate: null, // local date key "YYYY-MM-DD" currently shown in Fixtures
  };

  // ---------- Date / time formatting ----------
  function formatKickoff(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (e) {
      return "";
    }
  }

  function isFuture(iso) {
    var d = new Date(iso).getTime();
    return !isNaN(d) && d > Date.now();
  }

  // Local calendar-date key ("YYYY-MM-DD") for a given Date, in the browser's
  // local timezone. A 23:00 UTC kickoff may land on a different local day —
  // that's intentional; we group by local day.
  function localDateKeyFromDate(d) {
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
  }

  // Local calendar-date key for an ISO kickoff string. Returns "" if invalid.
  function localDateKey(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return localDateKeyFromDate(d);
  }

  // Today's local date key.
  function todayDateKey() {
    return localDateKeyFromDate(new Date());
  }

  // Short label for a date key, e.g. "Thu 18 Jun".
  function formatDateChipLabel(key) {
    var parts = key.split("-");
    var d = new Date(
      parseInt(parts[0], 10),
      parseInt(parts[1], 10) - 1,
      parseInt(parts[2], 10)
    );
    if (isNaN(d.getTime())) return key;
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }

  // ---------- Screen routing ----------
  function showLogin() {
    hide($("app"));
    hide($("config-warn"));
    show($("login-screen"));
  }

  function showApp() {
    hide($("login-screen"));
    hide($("config-warn"));
    show($("app"));
    var name =
      (state.profile && state.profile.display_name) ||
      (state.user && state.user.email) ||
      "";
    $("user-name").textContent = name;
    $("profile-name").textContent = name;
    $("display-name-input").value =
      (state.profile && state.profile.display_name) || "";
  }

  // ---------- Auth ----------
  function slugify(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function bindLogin() {
    var btn = $("join-btn");
    var nameInput = $("name-input");
    var codeInput = $("code-input");
    var msg = $("login-msg");

    function setMsg(text, kind) {
      msg.textContent = text;
      msg.className = "login-msg " + (kind || "");
      show(msg);
    }

    async function join() {
      var name = (nameInput.value || "").trim();
      var code = (codeInput.value || "").trim();

      if (!name) {
        setMsg("Enter a display name", "err");
        return;
      }
      if (!code) {
        setMsg("Enter the group code", "err");
        return;
      }
      if (code !== GROUP_CODE) {
        setMsg("Incorrect group code", "err");
        return;
      }
      if (GROUP_CODE.length < 6) {
        setMsg("Group code must be at least 6 characters", "err");
        return;
      }

      var slug = slugify(name);
      if (!slug) {
        setMsg("Please use letters or numbers in your name", "err");
        return;
      }

      var email = slug + "@" + SYNTH_DOMAIN;
      var password = GROUP_CODE;

      btn.disabled = true;
      var original = btn.textContent;
      btn.textContent = "Joining...";

      try {
        var signInRes = await sb.auth.signInWithPassword({
          email: email,
          password: password,
        });

        if (signInRes.error) {
          // No existing account (or wrong password) — try to create one.
          var signUpRes = await sb.auth.signUp({
            email: email,
            password: password,
          });

          if (signUpRes.error) {
            var em = (signUpRes.error.message || "").toLowerCase();
            if (
              em.indexOf("already registered") !== -1 ||
              em.indexOf("already exists") !== -1 ||
              em.indexOf("already been registered") !== -1 ||
              em.indexOf("user already") !== -1
            ) {
              setMsg(
                "That name is taken (or the group code changed). Try a different name.",
                "err"
              );
              return;
            }
            setMsg(
              signUpRes.error.message || "Could not sign in. Try again.",
              "err"
            );
            return;
          }

          if (!signUpRes.data || !signUpRes.data.session) {
            setMsg(
              "Could not sign in. In Supabase, turn OFF 'Confirm email' under Authentication > Providers > Email.",
              "err"
            );
            return;
          }
        }

        // Successful auth — upsert the nicely-formatted display name.
        try {
          var userRes = await sb.auth.getUser();
          var user = userRes.data ? userRes.data.user : null;
          if (user) {
            var up = await sb
              .from("profiles")
              .upsert({ id: user.id, display_name: name }, { onConflict: "id" });
            if (up.error) {
              console.log("profile upsert error", up.error);
            } else {
              // Reflect the typed name locally so UI shows it immediately,
              // even though onSignedIn may have loaded the slug first.
              state.profile = state.profile || { id: user.id };
              state.profile.display_name = name;
              if (state.user && $("user-name")) {
                $("user-name").textContent = name;
                $("profile-name").textContent = name;
                $("display-name-input").value = name;
              }
            }
          }
        } catch (e) {
          console.log("profile upsert exception", e);
        }
        // onAuthStateChange / signIn will route into the app via onSignedIn.
      } catch (err) {
        setMsg((err && err.message) || "Could not sign in. Try again.", "err");
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    }

    btn.addEventListener("click", join);
    function onEnter(e) {
      if (e.key === "Enter") join();
    }
    nameInput.addEventListener("keydown", onEnter);
    codeInput.addEventListener("keydown", onEnter);

    $("logout-btn").addEventListener("click", async function () {
      try {
        await sb.auth.signOut();
      } catch (e) {}
      // onAuthStateChange will route to login.
    });
  }

  async function loadProfile() {
    if (!state.user) return;
    try {
      var res = await sb
        .from("profiles")
        .select("id, display_name")
        .eq("id", state.user.id)
        .maybeSingle();
      if (!res.error && res.data) {
        state.profile = res.data;
      } else {
        // Fallback if the profile row isn't readable/created yet.
        state.profile = {
          id: state.user.id,
          display_name: (state.user.email || "").split("@")[0],
        };
      }
    } catch (e) {
      state.profile = {
        id: state.user.id,
        display_name: (state.user.email || "").split("@")[0],
      };
    }
  }

  async function onSignedIn(session) {
    state.user = session.user;
    await loadProfile();
    showApp();
    switchTab("fixtures");
    loadFixtures();
  }

  // ---------- Tabs ----------
  function bindTabs() {
    var btns = document.querySelectorAll(".tab-btn");
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener("click", function () {
        switchTab(b.getAttribute("data-tab"));
      });
    });
  }

  function switchTab(tab) {
    state.activeTab = tab;
    Array.prototype.forEach.call(
      document.querySelectorAll(".tab-btn"),
      function (b) {
        b.classList.toggle("active", b.getAttribute("data-tab") === tab);
      }
    );
    hide($("tab-fixtures"));
    hide($("tab-leaderboard"));
    hide($("tab-profile"));
    show($("tab-" + tab));
    if (tab === "leaderboard") loadLeaderboard();
  }

  // ---------- Crest rendering ----------
  function teamInitials(teamName) {
    return (teamName || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (w) {
        return w.charAt(0);
      })
      .join("")
      .toUpperCase();
  }

  function crestHtml(crest, teamName) {
    var initials = escapeHtml(teamInitials(teamName));
    var fallback = '<span class="crest-fallback">' + initials + "</span>";
    if (crest) {
      // data-fallback lets a delegated error handler swap in initials if the
      // image fails to load — avoids fragile inline onerror quoting.
      return (
        '<img class="crest" src="' +
        escapeHtml(crest) +
        '" alt="' +
        escapeHtml(teamName || "") +
        '" loading="lazy" data-fallback="' +
        initials +
        '" />'
      );
    }
    return fallback;
  }

  // Delegated handler: replace broken crest images with an initials chip.
  document.addEventListener(
    "error",
    function (e) {
      var t = e.target;
      if (t && t.tagName === "IMG" && t.classList.contains("crest")) {
        var span = document.createElement("span");
        span.className = "crest-fallback";
        span.textContent = t.getAttribute("data-fallback") || "";
        if (t.parentNode) t.parentNode.replaceChild(span, t);
      }
    },
    true // capture phase: img error events don't bubble
  );

  // ---------- Fixtures ----------
  async function loadFixtures() {
    var body = $("fixtures-body");
    body.innerHTML =
      '<div class="loading"><div class="spinner"></div>Loading fixtures...</div>';

    var matchRes, predRes;
    try {
      matchRes = await sb
        .from("matches")
        .select(
          "id, matchday, utc_kickoff, home_team, away_team, home_crest, away_crest, status, home_score, away_score"
        )
        .order("utc_kickoff", { ascending: true });
    } catch (e) {
      matchRes = { error: e };
    }

    if (matchRes.error) {
      body.innerHTML =
        '<div class="empty-state"><p>Could not load fixtures: ' +
        escapeHtml(matchRes.error.message || "unknown error") +
        "</p></div>";
      return;
    }

    state.matches = matchRes.data || [];

    // Load this user's predictions.
    state.predsByMatch = {};
    try {
      predRes = await sb
        .from("predictions")
        .select("match_id, home_pred, away_pred, points")
        .eq("user_id", state.user.id);
      if (!predRes.error && predRes.data) {
        predRes.data.forEach(function (p) {
          state.predsByMatch[p.match_id] = p;
        });
      }
    } catch (e) {
      /* predictions are optional; ignore read errors */
    }

    renderFixtures();
  }

  // Build the sorted list of distinct local match dates, each with its matches
  // (sorted by kickoff ascending) and a count. Returns { keys, byKey }.
  function buildDateIndex() {
    var byKey = {};
    var keys = [];
    state.matches.forEach(function (m) {
      var key = localDateKey(m.utc_kickoff);
      if (!key) return;
      if (!(key in byKey)) {
        byKey[key] = [];
        keys.push(key);
      }
      byKey[key].push(m);
    });
    keys.sort(); // "YYYY-MM-DD" sorts chronologically as strings
    keys.forEach(function (key) {
      byKey[key].sort(function (a, b) {
        return (
          new Date(a.utc_kickoff).getTime() - new Date(b.utc_kickoff).getTime()
        );
      });
    });
    return { keys: keys, byKey: byKey };
  }

  // Choose the default selected date per the rules:
  //   today (if it has matches) -> nearest upcoming -> most recent past.
  function defaultDateKey(keys) {
    if (!keys.length) return null;
    var today = todayDateKey();
    if (keys.indexOf(today) !== -1) return today;
    var upcoming = null;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] >= today) {
        upcoming = keys[i];
        break;
      }
    }
    if (upcoming) return upcoming;
    return keys[keys.length - 1]; // most recent past
  }

  function renderFixtures() {
    var body = $("fixtures-body");
    if (!state.matches.length) {
      body.innerHTML =
        '<div class="empty-state">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4" stroke-linecap="round"/></svg>' +
        "<p>Fixtures will appear once the results sync runs.</p></div>";
      return;
    }

    var idx = buildDateIndex();
    var keys = idx.keys;
    var byKey = idx.byKey;

    // Preserve current selection across re-renders; only fall back to the
    // default rule when there's no valid current selection (first load).
    if (!state.selectedDate || keys.indexOf(state.selectedDate) === -1) {
      state.selectedDate = defaultDateKey(keys);
    }
    var selected = state.selectedDate;
    var selectedIndex = keys.indexOf(selected);

    // ---- Navigator ----
    var prevDisabled = selectedIndex <= 0;
    var nextDisabled = selectedIndex < 0 || selectedIndex >= keys.length - 1;

    var navHtml =
      '<div class="date-nav">' +
      '<button class="date-nav-arrow" data-nav="prev" aria-label="Previous date"' +
      (prevDisabled ? " disabled" : "") +
      ">&lsaquo;</button>" +
      '<div class="date-strip" id="date-strip">';

    keys.forEach(function (key) {
      var count = byKey[key].length;
      navHtml +=
        '<button class="date-chip' +
        (key === selected ? " selected" : "") +
        '" data-date="' +
        escapeHtml(key) +
        '"' +
        (key === selected ? ' aria-current="true"' : "") +
        ">" +
        '<span class="date-chip-day">' +
        escapeHtml(formatDateChipLabel(key)) +
        "</span>" +
        '<span class="date-chip-count">' +
        count +
        (count === 1 ? " game" : " games") +
        "</span>" +
        "</button>";
    });

    navHtml +=
      "</div>" +
      '<button class="date-nav-arrow" data-nav="next" aria-label="Next date"' +
      (nextDisabled ? " disabled" : "") +
      ">&rsaquo;</button>" +
      '<button class="btn btn-sm date-today" data-nav="today">Today</button>' +
      "</div>";

    // ---- Day's matches ----
    var dayHtml = "";
    var items = (selected && byKey[selected]) || [];
    if (!items.length) {
      dayHtml =
        '<div class="empty-state"><p>No matches on this day.</p></div>';
    } else {
      items.forEach(function (m) {
        dayHtml += matchCardHtml(m);
      });
    }

    body.innerHTML = navHtml + '<div class="day-matches">' + dayHtml + "</div>";

    // Bind navigator controls.
    Array.prototype.forEach.call(
      body.querySelectorAll(".date-chip"),
      function (chip) {
        chip.addEventListener("click", function () {
          selectDate(chip.getAttribute("data-date"));
        });
      }
    );
    Array.prototype.forEach.call(
      body.querySelectorAll("[data-nav]"),
      function (btn) {
        btn.addEventListener("click", function () {
          var nav = btn.getAttribute("data-nav");
          if (nav === "prev") {
            if (selectedIndex > 0) selectDate(keys[selectedIndex - 1]);
          } else if (nav === "next") {
            if (selectedIndex >= 0 && selectedIndex < keys.length - 1)
              selectDate(keys[selectedIndex + 1]);
          } else if (nav === "today") {
            var today = todayDateKey();
            selectDate(
              keys.indexOf(today) !== -1 ? today : defaultDateKey(keys)
            );
          }
        });
      }
    );

    // Bind save buttons (same code path as before).
    Array.prototype.forEach.call(
      body.querySelectorAll("[data-save]"),
      function (btn) {
        btn.addEventListener("click", function () {
          savePrediction(btn.getAttribute("data-save"), btn);
        });
      }
    );

    // Auto-scroll the strip so the selected chip is visible.
    scrollSelectedChipIntoView();
  }

  function selectDate(key) {
    if (!key || key === state.selectedDate) {
      // Still ensure visibility even if unchanged.
      if (key) scrollSelectedChipIntoView();
      return;
    }
    state.selectedDate = key;
    renderFixtures();
  }

  function scrollSelectedChipIntoView() {
    var strip = $("date-strip");
    if (!strip) return;
    var chip = strip.querySelector(".date-chip.selected");
    if (chip && chip.scrollIntoView) {
      try {
        chip.scrollIntoView({ inline: "center", block: "nearest" });
      } catch (e) {
        // Older browsers: fall back to no-arg scrollIntoView.
        chip.scrollIntoView();
      }
    }
  }

  function statusBadge(m) {
    var s = (m.status || "").toUpperCase();
    if (s === "IN_PLAY" || s === "PAUSED") {
      // A football match can't realistically be live for more than ~3 hours.
      // If the data source still says live well past that, it's just stale
      // (results haven't synced yet) — show "Awaiting result" instead of Live.
      var kicked = new Date(m.utc_kickoff).getTime();
      var threeHrs = 3 * 60 * 60 * 1000;
      if (!isNaN(kicked) && Date.now() - kicked > threeHrs)
        return '<span class="status-badge pending">Awaiting result</span>';
      return '<span class="status-badge live">Live</span>';
    }
    if (s === "FINISHED")
      return '<span class="status-badge finished">Finished</span>';
    if (isFuture(m.utc_kickoff))
      return '<span class="status-badge upcoming">Upcoming</span>';
    return '<span class="status-badge">' + escapeHtml(s || "Scheduled") + "</span>";
  }

  function matchCardHtml(m) {
    var future = isFuture(m.utc_kickoff);
    var finished = (m.status || "").toUpperCase() === "FINISHED";
    var pred = state.predsByMatch[m.id];

    var teams =
      '<div class="teams">' +
      '<div class="team home">' +
      crestHtml(m.home_crest, m.home_team) +
      '<span class="team-name">' +
      escapeHtml(m.home_team) +
      "</span></div>";

    if (
      finished &&
      m.home_score != null &&
      m.away_score != null
    ) {
      teams +=
        '<span class="actual-score">' +
        m.home_score +
        " &ndash; " +
        m.away_score +
        "</span>";
    } else {
      teams += '<span class="vs">vs</span>';
    }

    teams +=
      '<div class="team away">' +
      crestHtml(m.away_crest, m.away_team) +
      '<span class="team-name">' +
      escapeHtml(m.away_team) +
      "</span></div></div>";

    var lower = "";
    if (future) {
      var hv = pred ? pred.home_pred : "";
      var av = pred ? pred.away_pred : "";
      lower =
        '<div class="pred-row">' +
        '<span class="pred-label">Your pick</span>' +
        '<div class="pred-inputs">' +
        '<input class="goal-input" type="number" min="0" max="30" step="1" inputmode="numeric" value="' +
        hv +
        '" id="h-' +
        m.id +
        '" aria-label="Home goals" />' +
        '<span class="goal-dash">&ndash;</span>' +
        '<input class="goal-input" type="number" min="0" max="30" step="1" inputmode="numeric" value="' +
        av +
        '" id="a-' +
        m.id +
        '" aria-label="Away goals" />' +
        "</div>" +
        '<button class="btn btn-primary btn-sm pred-save" data-save="' +
        m.id +
        '">Save</button>' +
        "</div>";
    } else {
      // Locked (kickoff passed).
      var lockIcon =
        '<span class="lock-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Locked</span>';
      if (pred) {
        var badge = "";
        if (finished && pred.points != null) {
          badge =
            '<span class="points-badge p' +
            pred.points +
            '">+' +
            pred.points +
            " pts</span>";
        }
        lower =
          '<div class="pred-readonly">' +
          '<span class="pred-label">Your pick</span>' +
          '<span class="pred-value">' +
          pred.home_pred +
          " &ndash; " +
          pred.away_pred +
          "</span>" +
          lockIcon +
          badge +
          "</div>";
      } else {
        lower =
          '<div class="pred-readonly">' +
          '<span class="no-pred">No prediction made</span>' +
          lockIcon +
          "</div>";
      }
    }

    return (
      '<div class="match-card' +
      (future ? "" : " locked") +
      '">' +
      '<div class="match-meta">' +
      '<span class="match-time">' +
      escapeHtml(formatKickoff(m.utc_kickoff)) +
      "</span>" +
      statusBadge(m) +
      "</div>" +
      teams +
      lower +
      "</div>"
    );
  }

  function clampGoal(v) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return null;
    if (n < 0) n = 0;
    if (n > 30) n = 30;
    return n;
  }

  async function savePrediction(matchId, btn) {
    var home = clampGoal($("h-" + matchId).value);
    var away = clampGoal($("a-" + matchId).value);
    if (home === null || away === null) {
      toast("Enter both scores (0-30).", "err");
      return;
    }
    // reflect clamped values back into inputs
    $("h-" + matchId).value = home;
    $("a-" + matchId).value = away;

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = "Saving...";
    try {
      var res = await sb.from("predictions").upsert(
        {
          user_id: state.user.id,
          match_id: Number(matchId),
          home_pred: home,
          away_pred: away,
        },
        { onConflict: "user_id,match_id" }
      );
      if (res.error) throw res.error;
      state.predsByMatch[matchId] = {
        match_id: Number(matchId),
        home_pred: home,
        away_pred: away,
        points: null,
      };
      toast("Prediction saved.", "ok");
    } catch (err) {
      toast((err && err.message) || "Could not save prediction.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  // ---------- Leaderboard ----------
  async function loadLeaderboard() {
    var body = $("leaderboard-body");
    body.innerHTML =
      '<div class="loading"><div class="spinner"></div>Loading leaderboard...</div>';
    var res;
    try {
      res = await sb
        .from("leaderboard")
        .select("*")
        .order("total_points", { ascending: false })
        .order("exact_scores", { ascending: false });
    } catch (e) {
      res = { error: e };
    }

    if (res.error) {
      body.innerHTML =
        '<div class="empty-state"><p>Could not load leaderboard: ' +
        escapeHtml(res.error.message || "unknown error") +
        "</p></div>";
      return;
    }

    var rows = res.data || [];
    if (!rows.length) {
      body.innerHTML =
        '<div class="empty-state">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 21V10M12 21V4M18 21v-7" stroke-linecap="round"/></svg>' +
        "<p>No standings yet. Scores appear after the first results sync.</p></div>";
      return;
    }

    var myId = state.user && state.user.id;
    var html =
      '<table class="lb-table"><thead><tr>' +
      "<th>#</th><th>Player</th>" +
      '<th class="lb-col-breakdown">Breakdown</th>' +
      '<th style="text-align:right">Pts</th>' +
      "</tr></thead><tbody>";

    rows.forEach(function (r, i) {
      var me = myId && r.user_id === myId;
      html +=
        '<tr class="' +
        (me ? "lb-row-me" : "") +
        '">' +
        '<td class="lb-rank' +
        (i === 0 ? " top1" : "") +
        '">' +
        (i + 1) +
        "</td>" +
        '<td class="lb-name">' +
        escapeHtml(r.display_name || "Player") +
        "</td>" +
        '<td class="lb-col-breakdown lb-breakdown">' +
        "<b>" +
        (r.exact_scores || 0) +
        "</b> exact &middot; <b>" +
        (r.goal_diffs || 0) +
        "</b> diff &middot; <b>" +
        (r.correct_results || 0) +
        "</b> result</td>" +
        '<td class="lb-points">' +
        (r.total_points || 0) +
        "</td>" +
        "</tr>";
    });
    html += "</tbody></table>";
    body.innerHTML = html;
  }

  // ---------- Profile ----------
  function bindProfile() {
    $("save-name-btn").addEventListener("click", async function () {
      var btn = this;
      var name = ($("display-name-input").value || "").trim();
      if (!name) {
        toast("Display name cannot be empty.", "err");
        return;
      }
      btn.disabled = true;
      var original = btn.textContent;
      btn.textContent = "Saving...";
      try {
        var res = await sb
          .from("profiles")
          .update({ display_name: name })
          .eq("id", state.user.id);
        if (res.error) throw res.error;
        state.profile = state.profile || {};
        state.profile.display_name = name;
        $("user-name").textContent = name;
        toast("Display name updated.", "ok");
      } catch (err) {
        toast((err && err.message) || "Could not update name.", "err");
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }

  // ---------- Refresh results (Netlify function) ----------
  function bindRefresh() {
    $("refresh-btn").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      var original = btn.textContent;
      btn.textContent = "Refreshing...";
      try {
        var resp = await fetch("/.netlify/functions/sync-results", {
          method: "GET",
        });
        if (resp.ok) {
          toast("Results refreshed. Reloading fixtures...", "ok");
          await loadFixtures();
          if (state.activeTab === "leaderboard") loadLeaderboard();
        } else if (resp.status === 404) {
          toast(
            "Sync function not available in this environment.",
            "err"
          );
        } else {
          toast("Refresh failed (" + resp.status + ").", "err");
        }
      } catch (e) {
        toast(
          "Could not reach the sync function (offline or local dev).",
          "err"
        );
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }

  // ---------- Boot ----------
  async function boot() {
    bindLogin();
    bindTabs();
    bindProfile();
    bindRefresh();

    // React to auth changes (covers magic-link return + logout).
    sb.auth.onAuthStateChange(function (event, session) {
      if (session && session.user) {
        // Avoid re-loading everything on token refresh if already shown.
        if (!state.user || state.user.id !== session.user.id) {
          onSignedIn(session);
        }
      } else {
        state.user = null;
        state.profile = null;
        showLogin();
      }
    });

    // Initial session check.
    try {
      var res = await sb.auth.getSession();
      var session = res.data ? res.data.session : null;
      if (session && session.user) {
        await onSignedIn(session);
      } else {
        showLogin();
      }
    } catch (e) {
      showLogin();
    }
  }

  boot();
})();
