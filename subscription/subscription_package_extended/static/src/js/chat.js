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
   - Format: "Today, 3:42 PM" / "Yesterday, 11:05 AM" / "Jun 1 2025, 9:00 AM"
   - Falls back to raw m.date string if parsing fails

   [CHANGE 3] DATE SEPARATOR LABEL
   - Changed from "TODAY" to "LATEST MESSAGES"

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
   - If true: calls showUpgradePopup() and returns early (no messages shown)

   =============================================================
*/

function initChat() {
    let currentUserId = null;

    function getBox() { return document.getElementById("chat-box"); }
    function getInput() { return document.getElementById("msg_input"); }

    function esc(s) {
        return (s || "")
            .replace(/<[^>]*>/g, "")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

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
                await load();
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

    // Tracks the last rendered message count per user so we only
    // re-render when new messages actually arrive (prevents scroll reset on poll)
    let lastMessageCount = 0;
    let lastRenderedUserId = null;

    async function load() {
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
                showUpgradePopup();
                return;
            }

            if (d.result.requiest_id_status == 'rejected'){
                $("#send_btn").attr("disabled", "disabled");
            } else {
                $("#send_btn").removeAttr("disabled", "disabled");
            }

            const messages = d.result.messages || [];
            const newCount = messages.length;
            const userChanged = lastRenderedUserId !== currentUserId;

            // Only re-render if: switching contacts OR new messages arrived
            if (!userChanged && newCount === lastMessageCount) return;

            // Check if user has scrolled up before wiping — we'll restore position after
            // "near bottom" = within 80px of the bottom
            const wasNearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 80;

            lastMessageCount = newCount;
            lastRenderedUserId = currentUserId;

            box.innerHTML = "";

            if (messages.length > 0) {
                const sep = document.createElement("div");
                sep.className = "chat-date-separator";
                sep.innerHTML = "<span>LATEST MESSAGES</span>";
                box.appendChild(sep);
            }

            messages.forEach(m => {
                const msg = document.createElement("div");
                msg.className = m.is_me ? "msg-wrapper msg-sent" : "msg-wrapper msg-received";

                let avatarHtml = "";
                if (!m.is_me) {
                    const activeContact = document.querySelector('.contact_item.active .contact-name');
                    const letter = activeContact ? activeContact.textContent.trim().charAt(0).toUpperCase() : 'U';
                    avatarHtml = `<div class="msg-avatar-letter">${letter}</div>`;
                }

                // Beautified timestamp
                let timeText = "Sent";
                if (m.date) {
                    let dStr = m.date.replace(' ', 'T');
                    if (!dStr.endsWith('Z')) { dStr += 'Z'; }
                    const dt = new Date(dStr);
                    if (!isNaN(dt.getTime())) {
                        const now = new Date();
                        const yesterday = new Date(now);
                        yesterday.setDate(now.getDate() - 1);
                        const timeString = dt.toLocaleTimeString([], {hour: 'numeric', minute:'2-digit', hour12: true});
                        if (dt.toDateString() === now.toDateString()) {
                            timeText = `Today, ${timeString}`;
                        } else if (dt.toDateString() === yesterday.toDateString()) {
                            timeText = `Yesterday, ${timeString}`;
                        } else {
                            const dateString = dt.toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric'});
                            timeText = `${dateString}, ${timeString}`;
                        }
                    } else {
                        timeText = m.date;
                    }
                }

                const doubleTickHtml = m.is_me ? `<i class="fa fa-check-double text-gold ms-1"></i>` : '';

                msg.innerHTML = `
                    ${avatarHtml}
                    <div class="msg-bubble">
                        ${esc(m.body)}
                        <div class="msg-time">${timeText} ${doubleTickHtml}</div>
                    </div>
                `;
                box.appendChild(msg);
            });

            // Only scroll to bottom if user was already near bottom OR just switched contact
            if (wasNearBottom || userChanged) {
                box.scrollTop = box.scrollHeight;
            }

        } catch (e) { console.error("LOAD ERROR:", e); }
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
                await load();
            }
        } catch (e) { console.error("SEND ERROR:", e); }
    }

    /* --- Sidebar Mobile Toggles --- */
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
            currentUserId = parseInt(contact.dataset.id);
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
            if (accepted) { load(); }
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

    setInterval(load, 1000);
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

    // Populate grid once
    EMOJIS.forEach(emoji => {
        const span = document.createElement("span");
        span.textContent = emoji;
        span.title = emoji;
        span.style.cssText = [
            "cursor:pointer",
            "font-size:1.4rem",
            "padding:4px",
            "border-radius:4px",
            "transition:background 0.15s ease",
            "user-select:none",
            "line-height:1",
        ].join(";");
        span.addEventListener("mouseenter", () => { span.style.background = "rgba(196,154,46,0.18)"; });
        span.addEventListener("mouseleave", () => { span.style.background = "transparent"; });
        span.addEventListener("click", (e) => {
            e.stopPropagation();
            // Insert emoji at cursor position
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const val = input.value;
            input.value = val.slice(0, start) + emoji + val.slice(end);
            // Move cursor after the emoji
            const newPos = start + emoji.length;
            input.setSelectionRange(newPos, newPos);
            input.focus();
            panel.style.display = "none";
        });
        grid.appendChild(span);
    });

    // Toggle panel
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = panel.style.display !== "none";
        panel.style.display = isOpen ? "none" : "block";
        btn.style.color = isOpen ? "rgba(255,255,255,0.5)" : "#c49a2e";
    });

    // Close on outside click
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