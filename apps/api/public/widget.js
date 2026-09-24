/*
 * Widget de chat embebible. Una línea en la web del cliente:
 *   <script src="https://API/widget.js" data-agent="AGENT_ID" data-key="WIDGET_KEY" async></script>
 * Opcionales: data-title, data-color, data-greeting, data-position="left".
 * Web component con Shadow DOM: no hereda ni rompe los estilos de la web anfitriona.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || customElements.get("agentes-chat")) return;
  var API = new URL(script.src).origin;

  class AgentesChat extends HTMLElement {
    connectedCallback() {
      var agent = this.getAttribute("agent");
      var key = this.getAttribute("key");
      var color = this.getAttribute("color") || "#2b59c3";
      var title = this.getAttribute("title-text") || "Atención al cliente";
      var greeting = this.getAttribute("greeting") || "¡Hola! ¿En qué puedo ayudarte?";
      var left = this.getAttribute("position") === "left";
      var storeKey = "agentes-conv-" + agent;
      var root = this.attachShadow({ mode: "open" });
      root.innerHTML =
        "<style>" +
        ":host{all:initial;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
        ".btn{position:fixed;bottom:20px;" + (left ? "left" : "right") + ":20px;width:56px;height:56px;border-radius:50%;border:0;background:" + color + ";color:#fff;font-size:24px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2);z-index:2147483646}" +
        ".panel{position:fixed;bottom:88px;" + (left ? "left" : "right") + ":20px;width:min(360px,calc(100vw - 32px));height:min(520px,calc(100vh - 120px));background:#fff;color:#1a1a1a;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.2);display:none;flex-direction:column;overflow:hidden;z-index:2147483647}" +
        ".panel.open{display:flex}.head{background:" + color + ";color:#fff;padding:12px 16px;font-weight:600}" +
        ".log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f6f7f9}" +
        ".m{max-width:85%;padding:8px 12px;border-radius:12px;line-height:1.4;font-size:14px;white-space:pre-wrap;word-wrap:break-word}" +
        ".agent{background:#fff;border:1px solid #e3e5e8;align-self:flex-start}.me{background:" + color + ";color:#fff;align-self:flex-end}" +
        ".note{font-size:12px;color:#666;align-self:center;text-align:center}" +
        "form{display:flex;border-top:1px solid #e3e5e8}input{flex:1;border:0;padding:12px;font-size:14px;outline:none;background:#fff;color:#1a1a1a}" +
        "button.send{border:0;background:none;color:" + color + ";font-weight:600;padding:0 14px;cursor:pointer}" +
        "</style>" +
        '<button class="btn" aria-label="Abrir chat">💬</button>' +
        '<div class="panel" role="dialog" aria-label="' + title + '"><div class="head"></div><div class="log" aria-live="polite"></div>' +
        '<form><input placeholder="Escribe tu mensaje…" aria-label="Mensaje" autocomplete="off"/><button class="send">Enviar</button></form></div>';
      var panel = root.querySelector(".panel");
      var log = root.querySelector(".log");
      var input = root.querySelector("input");
      root.querySelector(".head").textContent = title;
      function add(text, cls) {
        var d = document.createElement("div");
        d.className = "m " + cls;
        d.textContent = text;
        log.appendChild(d);
        log.scrollTop = log.scrollHeight;
        return d;
      }
      add(greeting, "agent");
      root.querySelector(".btn").onclick = function () {
        panel.classList.toggle("open");
        if (panel.classList.contains("open")) input.focus();
      };
      root.querySelector("form").onsubmit = async function (e) {
        e.preventDefault();
        var text = input.value.trim();
        if (!text) return;
        input.value = "";
        add(text, "me");
        var typing = add("…", "agent");
        var conv = null;
        try { conv = sessionStorage.getItem(storeKey); } catch (_) {}
        try {
          var r = await fetch(API + "/v1/agents/" + agent + "/chat", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + key },
            body: JSON.stringify(conv ? { message: text, conversation_id: conv } : { message: text }),
          });
          var data = await r.json();
          if (!r.ok) throw new Error(data.error || "error");
          try { sessionStorage.setItem(storeKey, data.conversation_id); } catch (_) {}
          typing.remove();
          if (data.reply) add(data.reply, "agent");
          if (data.status === "handoff") add("Una persona del equipo continuará la conversación.", "note");
          if (data.status === "awaiting_approval") add("Tu solicitud está pendiente de revisión por el equipo.", "note");
        } catch (err) {
          typing.textContent = "No he podido enviar el mensaje. Inténtalo de nuevo.";
        }
      };
    }
  }
  customElements.define("agentes-chat", AgentesChat);

  var el = document.createElement("agentes-chat");
  el.setAttribute("agent", script.dataset.agent || "");
  el.setAttribute("key", script.dataset.key || "");
  if (script.dataset.color) el.setAttribute("color", script.dataset.color);
  if (script.dataset.title) el.setAttribute("title-text", script.dataset.title);
  if (script.dataset.greeting) el.setAttribute("greeting", script.dataset.greeting);
  if (script.dataset.position) el.setAttribute("position", script.dataset.position);
  (document.body || document.documentElement).appendChild(el);
})();
