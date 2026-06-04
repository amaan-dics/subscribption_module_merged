/** @odoo-module **/

/* =============================================================
   CHAT.JS — CHANGELOG  (for merge reference)
   =============================================================

   [CHANGE 1] EMOJI PICKER
   - Added initEmojiPicker() function
   - Populates #emoji_grid with a curated emoji set
   - Toggle panel open/close on #emoji_btn click
   - Clicking an emoji inserts it at cursor position in #msg_input
   - Clicking outside the panel closes it

   [CHANGE 2] TIMESTAMP BEAUTIFICATION
   - Old: m.date || new Date().toLocaleTimeString(...)
     → caused ALL messages to show current time at render
   - New: parses m.date as UTC (appends Z), converts to local time
   - Format: "3:42 PM" (time only — date shown via day-section header)
   - Falls back to raw m.date string if parsing fails

   [CHANGE 3] DATE SEPARATOR LABEL
   - Removed "LATEST MESSAGES" static separator
   - Replaced with per-day section headers: "Today", "Yesterday", "Mon 2 Jun 2025"
   - Each section groups all messages sent/received on that calendar day
   - Timestamp inside each bubble now shows TIME ONLY (no date prefix)
     because the date context is already given by the section header

   [CHANGE 4] SIDEBAR MOBILE TOGGLE REFACTOR
   - Moved btnToggle/btnClose listeners into the main document click
     handler using e.target.closest() instead of separate listeners
   - Prevents duplicate event binding on re-init

   [CHANGE 5] UPGRADE POPUP  (chat limit enforcement)
   - Added showUpgradePopup() function
   - Called from load() when d.result.chat_limit_reached === true
   - Shows a modal with "UPGRADE PLAN" → /#pricing and a CLOSE button

   [CHANGE 6] chat_limit_reached HANDLING in load()
   - After fetching /chat/messages, checks d.result.chat_limit_reached
   - If true: disables input + send button inline, shows locked banner
     instead of showing a blocking popup (old behaviour was popup + early return)
   - User can still SEE all previous messages in the chat
   - Old behaviour: showUpgradePopup() + return (hid all messages)
   - New behaviour: render messages normally, then lock the composer area

   [CHANGE 7] DAY-BUCKET PRELOAD + ONE-DAY-AT-A-TIME SCROLL PAGINATION
   - Strategy: fetch ALL messages once into allMessages[] cache on contact open.
     No extra backend call is ever made while scrolling — all filtering is
     done client-side from that single cached array.
   - Initial display: show the most recent day that has messages.
     Priority: today → yesterday → day-before-yesterday → oldest day found.
     This ensures the screen is never blank even if no messages today.
   - Scroll-up pagination: each time the sentinel enters view, exactly ONE
     previous calendar day is prepended and a new sentinel is injected above it.
     The sentinel is removed only when there are no more older days left.
   - oldestVisibleDate tracks the boundary: each scroll step loads the day
     immediately before it, then updates oldestVisibleDate to that day.
   - allMessages cache is refreshed by pollLoad() so new incoming messages
     are always available for display without another contact-open fetch.
   - Previous bug (fixed): old code fetched "all older messages" in one shot
     on first scroll, which loaded yesterday AND all previous days at once.
     New code loads exactly one day per scroll interaction.

   =============================================================
*/

function initChat() {
    let currentUserId = null;

    // [CHANGE 7] Per-contact state for day-bucket pagination
    // allMessages: full sorted message list fetched once on contact open
    // oldestVisibleDate: JS Date set to midnight of oldest currently-shown day
    //   — each scroll step loads the day just before this boundary
    // noMoreHistory: true once we've prepended the very first day
    let allMessages = [];
    let oldestVisibleDate = null;
    let noMoreHistory = false;

    // IntersectionObserver for the scroll-up sentinel
    let sentinelObserver = null;

    function getBox() { return document.getElementById("chat-box"); }
    function getInput() { return document.getElementById("msg_input"); }

    // Parse a server date string ("2025-06-01 14:23:00") to a local JS Date
    function parseDate(dateStr) {
        if (!dateStr) return null;
        let s = dateStr.replace(' ', 'T');
        if (!s.endsWith('Z')) s += 'Z';
        const dt = new Date(s);
        return isNaN(dt.getTime()) ? null : dt;
    }

    // Midnight (local) of whatever date dt falls on
    function localMidnight(dt) {
        const d = new Date(dt);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    function esc(s) {
        return (s || "")
            .replace(/<[^>]*>/g, "")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    // ------------------------------------------------------------------
    // [CHANGE 6] Lock / unlock the composer area inline
    // ------------------------------------------------------------------
    function lockComposer(reason) {
        const input = getInput();
        const sendBtn = document.getElementById("send_btn");
        const emojiBtn = document.getElementById("emoji_btn");
        if (input) {
            input.disabled = true;
            input.placeholder = reason || "Chat unavailable";
        }
        if (sendBtn) sendBtn.disabled = true;
        if (emojiBtn) emojiBtn.disabled = true;

        const box = getBox();
        if (box && !document.getElementById("chat-limit-banner")) {
            const banner = document.createElement("div");
            banner.id = "chat-limit-banner";
            banner.className = "chat-limit-banner";
            banner.innerHTML = `
                <span class="chat-limit-banner-icon">🔒</span>
                <span class="chat-limit-banner-text">Chat limit reached for your plan.</span>
                <a href="/#pricing" class="chat-limit-banner-btn">Upgrade Plan</a>
            `;
            box.parentNode.insertBefore(banner, box.nextSibling);
        }
    }

    function unlockComposer() {
        const input = getInput();
        const sendBtn = document.getElementById("send_btn");
        const emojiBtn = document.getElementById("emoji_btn");
        if (input) {
            input.disabled = false;
            input.placeholder = "Type your message with care and respect...";
        }
        if (sendBtn) sendBtn.disabled = false;
        if (emojiBtn) emojiBtn.disabled = false;

        const banner = document.getElementById("chat-limit-banner");
        if (banner) banner.remove();
    }

    // ------------------------------------------------------------------
    // Terms popup
    // ------------------------------------------------------------------
    function showTermsPopup(content) {
        const old = document.getElementById("terms-overlay");
        if (old) old.remove();
        const wrapper = document.createElement("div");
        wrapper.id = "terms-overlay";
        wrapper.innerHTML = `
            <div style="position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 99999; display: flex; align-items: center; justify-content: center;">
                <div style="background: #111c14; color: white; width: 500px; max-width: 95%; border-radius: 8px; border: 1px solid rgba(196, 154, 46, 0.2); padding: 24px;">
                    <h4 style="color: #c49a2e; font-family: 'Playfair Display', serif;">Terms & Conditions</h4>
                    <div style="max-height: 300px; overflow-y: auto; margin-top: 15px; margin-bottom: 20px; font-size: 0.9rem; color: rgba(255,255,255,0.8);">
                        ${content}
                    </div>
                    <div class="mb-4 d-flex align-items-center gap-2">
                        <input type="checkbox" id="accept_terms" style="cursor: pointer; width: 16px; height: 16px;"/>
                        <label for="accept_terms" style="cursor: pointer; margin: 0; font-size: 0.9rem;">I agree to the Terms & Conditions</label>
                    </div>
                    <button id="accept_btn" class="btn btn-gold w-100" style="background: #e0b84a; color: #000; border: none; padding: 10px; border-radius: 4px; font-weight: 600;" disabled>
                        CONTINUE
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(wrapper);
        const checkbox = document.getElementById("accept_terms");
        const btn = document.getElementById("accept_btn");
        checkbox.addEventListener("change", function () { btn.disabled = !checkbox.checked; });
        btn.addEventListener("click", async function () {
            try {
                await fetch('/chat/terms/accept', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { user_id: currentUserId } })
                });
                wrapper.remove();
                await openContact();
            } catch (e) { console.error("ACCEPT ERROR:", e); }
        });
    }

    async function checkNotifications() {
        try {
            const r = await fetch('/portal/notifications', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {} })
            });
            const d = await r.json();
            const list = d.result.notifications || [];
            list.forEach(n => { showPopupNotification(n); });
        } catch (e) { console.error("Notification error:", e); }
    }

    function showPopupNotification(n) {
        let container = document.getElementById("chat-notification-container");
        if (!container) {
            container = document.createElement("div");
            container.id = "chat-notification-container";
            container.className = "chat-notification-container";
            document.body.appendChild(container);
        }
        const notif = document.createElement("div");
        notif.className = "chat-notification";
        notif.innerHTML = `
        <img class="notif-avatar" src="${n.image || '/web/static/img/avatar.png'}"/>
        <div class="notif-content">
            <div class="notif-title">${n.from}</div>
            <div class="notif-msg">${n.message}</div>
        </div>`;
        container.appendChild(notif);
        setTimeout(() => { notif.classList.add("show"); }, 50);
        notif.onclick = () => { window.location.href = `/chatbox?user_id=${parseInt(n.from_id)}`; };
        setTimeout(() => {
            notif.classList.remove("show");
            setTimeout(() => { notif.remove(); }, 300);
        }, 5000);
    }

    async function checkTerms() {
        if (!currentUserId) return true;
        try {
            const res = await fetch('/chat/terms', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { user_id: currentUserId } })
            });
            const data = await res.json();
            const result = data.result || {};
            if (!result.accepted) {
                showTermsPopup(result.content || "Please accept terms.");
                return false;
            }
            return true;
        } catch (e) { console.error("TERMS ERROR:", e); return false; }
    }

    // Tracks the last rendered message count per user so pollLoad()
    // only re-renders when new messages actually arrive
    let lastMessageCount = 0;
    let lastRenderedUserId = null;

    // ------------------------------------------------------------------
    // [CHANGE 3] Day label helper
    // ------------------------------------------------------------------
    function formatDayLabel(dt) {
        const now = new Date();
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (dt.toDateString() === now.toDateString()) return "Today";
        if (dt.toDateString() === yesterday.toDateString()) return "Yesterday";
        return dt.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }

    function timeOnly(dt) {
        return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    }

    // Build and return a DocumentFragment for a list of messages, grouped by day
    function buildMessageFragment(messages) {
        const groups = [];
        messages.forEach(m => {
            const dt = parseDate(m.date);
            m._dt = dt;
            const label = dt ? formatDayLabel(dt) : "Unknown";
            if (groups.length === 0 || groups[groups.length - 1].label !== label) {
                groups.push({ label, messages: [] });
            }
            groups[groups.length - 1].messages.push(m);
        });

        const frag = document.createDocumentFragment();
        groups.forEach(group => {
            const sep = document.createElement("div");
            sep.className = "chat-date-separator";
            sep.innerHTML = `<span>${group.label}</span>`;
            frag.appendChild(sep);

            group.messages.forEach(m => {
                const msg = document.createElement("div");
                msg.className = m.is_me ? "msg-wrapper msg-sent" : "msg-wrapper msg-received";

                let avatarHtml = "";
                if (!m.is_me) {
                    const activeContact = document.querySelector('.contact_item.active .contact-name');
                    const letter = activeContact ? activeContact.textContent.trim().charAt(0).toUpperCase() : 'U';
                    avatarHtml = `<div class="msg-avatar-letter">${letter}</div>`;
                }

                // [CHANGE 3] Time only in bubble — day context given by section header
                let timeText = "Sent";
                if (m._dt) timeText = timeOnly(m._dt);
                else if (m.date) timeText = m.date;

                const doubleTickHtml = m.is_me ? `<i class="fa fa-check-double text-gold ms-1"></i>` : '';

                msg.innerHTML = `
                    ${avatarHtml}
                    <div class="msg-bubble">
                        ${esc(m.body)}
                        <div class="msg-time">${timeText} ${doubleTickHtml}</div>
                    </div>
                `;
                frag.appendChild(msg);
            });
        });
        return frag;
    }

    // ------------------------------------------------------------------
    // [CHANGE 7] Sentinel: inject the "scroll up" hint and observe it.
    // When triggered, loads exactly ONE previous calendar day, then
    // re-injects itself so the next scroll loads the day before that.
    // ------------------------------------------------------------------
    function injectSentinel(box) {
        // Remove any existing sentinel + observer first
        if (sentinelObserver) { sentinelObserver.disconnect(); sentinelObserver = null; }
        const old = box.querySelector("#history-sentinel");
        if (old) old.remove();

        if (noMoreHistory) return; // nothing left to load

        const sentinel = document.createElement("div");
        sentinel.id = "history-sentinel";
        sentinel.className = "chat-history-sentinel";
        sentinel.innerHTML = `<span>↑ Scroll up to load earlier messages</span>`;
        box.insertBefore(sentinel, box.firstChild);

        sentinelObserver = new IntersectionObserver((entries) => {
            if (!entries[0].isIntersecting) return;
            sentinelObserver.disconnect();
            sentinelObserver = null;
            loadPreviousDay(box);
        }, { root: box, threshold: 0.1 });

        sentinelObserver.observe(sentinel);
    }

    // Load exactly the one calendar day immediately before oldestVisibleDate.
    // Called each time the sentinel scrolls into view.
    function loadPreviousDay(box) {
        if (!oldestVisibleDate || allMessages.length === 0) {
            noMoreHistory = true;
            const s = box.querySelector("#history-sentinel");
            if (s) s.remove();
            return;
        }

        // Find the latest day in allMessages that is strictly before oldestVisibleDate
        // "strictly before" = midnight of that day < oldestVisibleDate midnight
        const boundary = oldestVisibleDate.getTime(); // midnight of current oldest shown day

        // Collect all distinct day-midnights that are older than boundary
        const olderDays = new Set();
        allMessages.forEach(m => {
            const dt = m._dt || parseDate(m.date);
            if (!dt) return;
            const mid = localMidnight(dt).getTime();
            if (mid < boundary) olderDays.add(mid);
        });

        if (olderDays.size === 0) {
            // No more older days exist
            noMoreHistory = true;
            const s = box.querySelector("#history-sentinel");
            if (s) s.remove();
            return;
        }

        // Pick the most recent older day (the one just before the current boundary)
        const targetMidnight = Math.max(...olderDays);
        const targetMidnightDate = new Date(targetMidnight);

        // Filter messages that belong to exactly that day
        const dayMessages = allMessages.filter(m => {
            const dt = m._dt || parseDate(m.date);
            if (!dt) return false;
            return localMidnight(dt).getTime() === targetMidnight;
        });

        // Remove the sentinel before inserting content so we can anchor scroll
        const sentinel = box.querySelector("#history-sentinel");
        const scrollHeightBefore = box.scrollHeight;
        const scrollTopBefore = box.scrollTop;
        if (sentinel) sentinel.remove();

        // Prepend this day's messages at the very top
        if (dayMessages.length > 0) {
            const frag = buildMessageFragment(dayMessages);
            box.insertBefore(frag, box.firstChild);
            // Restore scroll position — user shouldn't jump
            box.scrollTop = scrollTopBefore + (box.scrollHeight - scrollHeightBefore);
        }

        // Advance the boundary to this day (so next scroll goes one day further back)
        oldestVisibleDate = targetMidnightDate;

        // Check if there are any days older than this new boundary
        const hasEvenOlder = allMessages.some(m => {
            const dt = m._dt || parseDate(m.date);
            return dt && localMidnight(dt).getTime() < targetMidnight;
        });

        if (hasEvenOlder) {
            injectSentinel(box); // re-arm for next scroll-up
        } else {
            noMoreHistory = true; // this was the last day — no more sentinel needed
        }
    }

    // ------------------------------------------------------------------
    // [CHANGE 7] openContact: fetches all messages once, determines which
    // day to show initially (today → yesterday → day-before → oldest),
    // renders only that day, and arms the sentinel for older days.
    // ------------------------------------------------------------------
    async function openContact() {
        if (!currentUserId) return;
        const box = getBox();
        if (!box) return;

        try {
            const r = await fetch('/chat/messages', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { user_id: currentUserId } })
            });
            const d = await r.json();

            // Limit / rejected-state handling
            if (d.result.chat_limit_reached) {
                lockComposer("Chat limit reached — upgrade your plan");
            } else {
                unlockComposer();
            }
            if (d.result.requiest_id_status === 'rejected') {
                const sb = document.getElementById("send_btn");
                if (sb) sb.setAttribute("disabled", "disabled");
            } else if (!d.result.chat_limit_reached) {
                const sb = document.getElementById("send_btn");
                if (sb) sb.removeAttribute("disabled");
            }

            // Cache all messages (sorted oldest→newest by server)
            allMessages = (d.result.messages || []).map(m => {
                m._dt = parseDate(m.date); // pre-parse once
                return m;
            });
            lastMessageCount = allMessages.length;
            lastRenderedUserId = currentUserId;

            box.innerHTML = "";
            noMoreHistory = false;
            oldestVisibleDate = null;

            if (allMessages.length === 0) return;

            // [CHANGE 7] Determine the initial day to display:
            // Try today first, then yesterday, then day-before-yesterday,
            // then fall back to whatever day the most recent message is on.
            const now = new Date();
            const todayMid   = localMidnight(now).getTime();
            const yestMid    = todayMid - 86400000;
            const dbydMid    = todayMid - 172800000; // day before yesterday

            const availableDays = new Set(
                allMessages
                    .filter(m => m._dt)
                    .map(m => localMidnight(m._dt).getTime())
            );

            let initialDay = null;
            if (availableDays.has(todayMid))   { initialDay = todayMid; }
            else if (availableDays.has(yestMid))  { initialDay = yestMid; }
            else if (availableDays.has(dbydMid))  { initialDay = dbydMid; }
            else {
                // Fall back: most recent day available
                initialDay = Math.max(...availableDays);
            }

            // Render that one day
            const initialMessages = allMessages.filter(
                m => m._dt && localMidnight(m._dt).getTime() === initialDay
            );
            const frag = buildMessageFragment(initialMessages);
            box.appendChild(frag);
            box.scrollTop = box.scrollHeight;

            // Set boundary so scroll-up knows what to load next
            oldestVisibleDate = new Date(initialDay);

            // If there are any days older than the initial day, arm the sentinel
            const hasOlder = allMessages.some(
                m => m._dt && localMidnight(m._dt).getTime() < initialDay
            );
            if (hasOlder) {
                injectSentinel(box);
            } else {
                noMoreHistory = true;
            }

        } catch (e) { console.error("OPEN CONTACT ERROR:", e); }
    }

    // ------------------------------------------------------------------
    // pollLoad: called every second to catch new incoming messages.
    // Re-fetches all messages; if count grew, refreshes the visible day
    // section (today / initial day) and updates allMessages cache.
    // Does NOT touch older-day sections or the sentinel.
    // ------------------------------------------------------------------
    async function pollLoad() {
        if (!currentUserId) return;
        const box = getBox();
        if (!box) return;

        try {
            const r = await fetch('/chat/messages', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { user_id: currentUserId } })
            });
            const d = await r.json();

            if (d.result.chat_limit_reached) {
                lockComposer("Chat limit reached — upgrade your plan");
            } else {
                unlockComposer();
            }
            if (d.result.requiest_id_status === 'rejected') {
                const sb = document.getElementById("send_btn");
                if (sb) sb.setAttribute("disabled", "disabled");
            } else if (!d.result.chat_limit_reached) {
                const sb = document.getElementById("send_btn");
                if (sb) sb.removeAttribute("disabled");
            }

            const freshMessages = (d.result.messages || []).map(m => {
                m._dt = parseDate(m.date);
                return m;
            });
            const newCount = freshMessages.length;
            if (newCount === lastMessageCount) return; // nothing new

            const wasNearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 80;
            lastMessageCount = newCount;
            allMessages = freshMessages; // refresh cache

            // Only append truly new messages (those after the last one we rendered).
            // We identify "new" as messages whose date is on or after oldestVisibleDate,
            // and whose count exceeds what we already have rendered.
            // Simple approach: re-render the currently visible day(s) in place.
            // Find all day-midnights that are >= oldestVisibleDate (i.e. already visible)
            if (!oldestVisibleDate) return;
            const visibleBoundary = oldestVisibleDate.getTime();

            const visibleMessages = allMessages.filter(
                m => m._dt && localMidnight(m._dt).getTime() >= visibleBoundary
            );

            // Preserve sentinel if present
            const hasSentinel = !!box.querySelector("#history-sentinel");

            // Remove everything after the sentinel (or all if no sentinel)
            const sentinel = box.querySelector("#history-sentinel");
            if (sentinel) {
                // Remove all siblings after sentinel
                while (sentinel.nextSibling) {
                    box.removeChild(sentinel.nextSibling);
                }
            } else {
                box.innerHTML = "";
            }

            if (visibleMessages.length > 0) {
                const frag = buildMessageFragment(visibleMessages);
                box.appendChild(frag);
            }

            // Re-arm sentinel observer if it was present
            if (hasSentinel && sentinel && sentinel.parentNode === box) {
                if (sentinelObserver) { sentinelObserver.disconnect(); sentinelObserver = null; }
                sentinelObserver = new IntersectionObserver((entries) => {
                    if (!entries[0].isIntersecting) return;
                    sentinelObserver.disconnect();
                    sentinelObserver = null;
                    loadPreviousDay(box);
                }, { root: box, threshold: 0.1 });
                sentinelObserver.observe(sentinel);
            }

            if (wasNearBottom) box.scrollTop = box.scrollHeight;

        } catch (e) { console.error("POLL ERROR:", e); }
    }

    async function send() {
        const input = getInput();
        if (!input) return;
        const msg = input.value.trim();
        if (!msg || !currentUserId) return;
        const accepted = await checkTerms();
        if (!accepted) return;
        try {
            const response = await fetch('/chat/send', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { user_id: currentUserId, message: msg } })
            });
            const data = await response.json();
            if (data.result.status === 'ok') {
                input.value = "";
                await pollLoad();
            }
        } catch (e) { console.error("SEND ERROR:", e); }
    }

    /* --- Sidebar Mobile Toggles + Contact Click --- */
    document.addEventListener("click", async function (e) {
        if (e.target.closest('#mobile_chat_toggle')) {
            e.preventDefault();
            document.querySelector('.chat-sidebar')?.classList.add('open');
            return;
        }
        if (e.target.closest('#mobile_chat_close')) {
            e.preventDefault();
            document.querySelector('.chat-sidebar')?.classList.remove('open');
            return;
        }

        const contact = e.target.closest(".contact_item");
        if (contact) {
            e.preventDefault();
            const newUserId = parseInt(contact.dataset.id);
            const isSwitch = newUserId !== currentUserId;

            currentUserId = newUserId;
            if (isSwitch) {
                // [CHANGE 7] Reset all per-contact state on switch
                allMessages = [];
                oldestVisibleDate = null;
                noMoreHistory = false;
                lastMessageCount = 0;
                lastRenderedUserId = null;
                if (sentinelObserver) { sentinelObserver.disconnect(); sentinelObserver = null; }
            }

            document.querySelectorAll(".contact_item").forEach(x => x.classList.remove("active"));
            contact.classList.add("active");

            document.querySelectorAll('.active-contact-header').forEach(h => h.classList.remove('d-flex'));
            document.querySelectorAll('.active-contact-header').forEach(h => h.classList.add('d-none'));
            const activeHeader = document.querySelector(`.active-contact-header[data-id="${currentUserId}"]`);
            if (activeHeader) {
                activeHeader.classList.remove('d-none');
                activeHeader.classList.add('d-flex');
            }

            if (window.innerWidth <= 768) {
                document.querySelector('.chat-sidebar')?.classList.remove('open');
            }

            const accepted = await checkTerms();
            if (accepted) { openContact(); }
            return;
        }
    });

    const params = new URLSearchParams(window.location.search);
    const selectedId = params.get("user_id");

    setTimeout(() => {
        const sendBtn = document.getElementById("send_btn");
        if (sendBtn) {
            sendBtn.addEventListener("click", function (e) {
                e.preventDefault(); send();
            });
        }
    }, 300);

    if (selectedId) {
        setTimeout(() => { document.querySelector(`.contact_item[data-id="${selectedId}"]`)?.click(); }, 300);
    } else {
        setTimeout(() => { document.querySelector(".contact_item")?.click(); }, 300);
    }

    setInterval(pollLoad, 1000);
    setInterval(checkNotifications, 1000);
    checkNotifications();

    /* ---- CHANGE 1: Emoji Picker ---- */
    initEmojiPicker();
}

function initEmojiPicker() {
    const EMOJIS = [
        // Smileys
        "😊","😂","🤣","😍","😘","😁","😎","🥰","😇","🤩",
        "😅","😆","🙂","😏","😌","🤗","😋","😜","😝","🤭",
        // Affection / Hearts
        "❤️","🧡","💛","💚","💙","💜","🖤","🤍","💕","💞",
        "💓","💗","💖","💝","💘","💌","🫶","🥹","😻","💑",
        // Gestures
        "👍","👎","👏","🙏","🤝","✌️","🤞","👋","🫂","💪",
        // Common expressions
        "😢","😭","😤","😠","😡","🤯","😳","🥺","😔","😞",
        "😒","🙄","😑","😶","🤐","😷","🤒","😴","🥱","😪",
        // Celebration
        "🎉","🎊","✨","🌟","⭐","🔥","💯","🎁","🎂","🥳",
        // Nature / misc
        "🌹","🌸","🌺","💐","🌙","☀️","🌈","⚡","❄️","🌊",
        // Food
        "☕","🍵","🧋","🍰","🍫","🍓","🍒","🌹",
        // Islamic / relevant
        "🕌","📿","☪️","🤲","🫀","📖","🌙","✨",
    ];

    const btn = document.getElementById("emoji_btn");
    const panel = document.getElementById("emoji_panel");
    const grid = document.getElementById("emoji_grid");
    const input = document.getElementById("msg_input");

    if (!btn || !panel || !grid || !input) return;

    EMOJIS.forEach(emoji => {
        const span = document.createElement("span");
        span.textContent = emoji;
        span.title = emoji;
        span.style.cssText = [
            "cursor:pointer", "font-size:1.4rem", "padding:4px",
            "border-radius:4px", "transition:background 0.15s ease",
            "user-select:none", "line-height:1",
        ].join(";");
        span.addEventListener("mouseenter", () => { span.style.background = "rgba(196,154,46,0.18)"; });
        span.addEventListener("mouseleave", () => { span.style.background = "transparent"; });
        span.addEventListener("click", (e) => {
            e.stopPropagation();
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const val = input.value;
            input.value = val.slice(0, start) + emoji + val.slice(end);
            const newPos = start + emoji.length;
            input.setSelectionRange(newPos, newPos);
            input.focus();
            panel.style.display = "none";
        });
        grid.appendChild(span);
    });

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = panel.style.display !== "none";
        panel.style.display = isOpen ? "none" : "block";
        btn.style.color = isOpen ? "rgba(255,255,255,0.5)" : "#c49a2e";
    });

    document.addEventListener("click", (e) => {
        if (!panel.contains(e.target) && e.target !== btn) {
            panel.style.display = "none";
            btn.style.color = "rgba(255,255,255,0.5)";
        }
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initChat);
} else {
    initChat();
}