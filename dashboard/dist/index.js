// WhatsApp Voice tab for the Hermes dashboard. Plain IIFE, no build step: React and UI come from the SDK.
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const { React } = SDK;
  const { useState, useEffect, useCallback } = SDK.hooks;
  const { Card, CardHeader, CardTitle, CardContent, Badge, Button, Input, Label } = SDK.components;
  const h = React.createElement;
  const API = "/api/plugins/hermes-whatsapp-voice";

  const get = (path) => SDK.fetchJSON(API + path);
  const post = (path, body) =>
    SDK.fetchJSON(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });

  function Section(title, ...children) {
    return h(Card, { className: "mb-4" }, h(CardHeader, null, h(CardTitle, null, title)), h(CardContent, null, ...children));
  }

  function Check({ ok, yes, no }) {
    return h(Badge, { variant: ok ? "default" : "destructive", className: "mr-2" }, ok ? yes : no);
  }

  function Status({ status, onRestart }) {
    const s = status.sidecar;
    return Section(
      "Status",
      h(
        "div",
        { className: "flex flex-wrap gap-y-2" },
        h(Check, { ok: !!(s && s.logged_in), yes: "Linked to WhatsApp", no: "Not linked" }),
        h(Check, { ok: !!s, yes: "Sidecar running" + (s ? " v" + s.version : ""), no: "Sidecar not running" }),
        h(Check, { ok: status.gemini_key, yes: "Gemini key found", no: "No Gemini key in Hermes" }),
        h(Check, { ok: status.hermes_api_key, yes: "Hermes API reachable", no: "API_SERVER_KEY not set" }),
        h(Check, { ok: !!status.owner_number, yes: "Owner " + status.owner_number, no: "Owner number not set" }),
      ),
      status.sidecar_error && h("p", { className: "mt-3 text-sm text-muted-foreground" }, status.sidecar_error),
      h(Button, { className: "mt-3", onClick: onRestart }, "Restart sidecar"),
    );
  }

  function Pair({ linked }) {
    const [state, setState] = useState("idle");
    const [svg, setSvg] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
      if (state !== "waiting") return undefined;
      const timer = setInterval(() => {
        get("/pair/qr")
          .then((r) => {
            setSvg(r.svg);
            setState(r.pairing === "idle" ? "waiting" : r.pairing);
          })
          .catch((e) => setError(String(e)));
      }, 1500);
      return () => clearInterval(timer);
    }, [state]);

    const start = () => {
      setError(null);
      post("/pair/start").then(() => setState("waiting")).catch((e) => setError(String(e)));
    };

    if (linked && state !== "linked") {
      return Section("Pairing", h("p", { className: "text-sm" }, "Linked. To re-link, remove this device on the bot's phone (Linked devices), then pair again."));
    }
    return Section(
      "Pairing",
      h("p", { className: "text-sm mb-3" }, "Links the sidecar to your bot's WhatsApp number as one more linked device (once)."),
      state === "linked" && h("p", { className: "text-sm font-medium" }, "Linked! Click Restart sidecar above."),
      state === "failed" && h("p", { className: "text-sm text-destructive" }, "Pairing stopped. Try again."),
      state === "waiting" &&
        h(
          "div",
          null,
          svg
            ? h("img", { alt: "WhatsApp pairing QR", src: "data:image/svg+xml;utf8," + encodeURIComponent(svg), style: { width: 280, background: "#fff", padding: 8 } })
            : h("p", { className: "text-sm" }, "Waiting for a QR code…"),
          h("p", { className: "text-sm mt-2" }, "On the bot's phone: WhatsApp > Linked devices > Link a device, then scan."),
          h(Button, { className: "mt-2", variant: "outline", onClick: () => post("/pair/stop").then(() => setState("idle")) }, "Cancel"),
        ),
      state !== "waiting" && state !== "linked" && h(Button, { onClick: start }, "Pair with WhatsApp"),
      error && h("p", { className: "text-sm text-destructive mt-2" }, error),
    );
  }

  function Field({ name, spec, value, onChange }) {
    const type = spec.type || "str";
    const label = h(Label, { className: "font-medium" }, name.replace(/_/g, " "));
    const help = spec.description && h("p", { className: "text-xs text-muted-foreground" }, spec.description);
    let input;
    if (type === "bool") {
      input = h("input", { type: "checkbox", checked: !!value, onChange: (e) => onChange(e.target.checked) });
    } else if (type === "dict") {
      input = h("textarea", {
        className: "w-full rounded border border-border bg-background p-2 font-mono text-xs",
        rows: 6,
        defaultValue: JSON.stringify(value || {}, null, 2),
        onChange: (e) => onChange(e.target.value),
      });
    } else {
      input = h(Input, {
        type: type === "int" ? "number" : "text",
        value: value === undefined || value === null ? "" : String(value),
        onChange: (e) => onChange(type === "int" ? Number(e.target.value) : e.target.value),
      });
    }
    return h("div", { className: "mb-4 grid gap-1" }, label, input, help);
  }

  function Settings({ onSaved }) {
    const [data, setData] = useState(null);
    const [draft, setDraft] = useState({});
    const [msg, setMsg] = useState(null);

    useEffect(() => {
      get("/settings").then(setData).catch((e) => setMsg(String(e)));
    }, []);

    if (!data) return Section("Settings", h("p", { className: "text-sm" }, msg || "Loading…"));

    const save = () => {
      const body = {};
      for (const [key, value] of Object.entries(draft)) {
        if ((data.schema[key].type || "str") === "dict") {
          try {
            body[key] = JSON.parse(value || "{}");
          } catch (e) {
            setMsg(key + " is not valid JSON");
            return;
          }
        } else {
          body[key] = value;
        }
      }
      post("/settings", body)
        .then(() => {
          setDraft({});
          setMsg("Saved. Restart the sidecar to apply.");
          onSaved();
        })
        .catch((e) => setMsg(String(e)));
    };

    return Section(
      "Settings",
      ...Object.entries(data.schema).map(([key, spec]) =>
        h(Field, {
          key,
          name: key,
          spec,
          value: key in draft && spec.type !== "dict" ? draft[key] : data.values[key],
          onChange: (v) => setDraft(Object.assign({}, draft, { [key]: v })),
        }),
      ),
      h(Button, { onClick: save, disabled: Object.keys(draft).length === 0 }, "Save"),
      msg && h("p", { className: "text-sm mt-2" }, msg),
    );
  }

  function Calls() {
    const [calls, setCalls] = useState([]);
    const [reason, setReason] = useState("");
    const [msg, setMsg] = useState(null);
    const [open, setOpen] = useState(null);
    const refresh = useCallback(() => get("/calls").then((r) => setCalls(r.calls)).catch((e) => setMsg(String(e))), []);

    useEffect(() => {
      refresh();
      const timer = setInterval(refresh, 4000);
      return () => clearInterval(timer);
    }, [refresh]);

    const call = () =>
      post("/call", { reason })
        .then(() => setMsg("Calling…"))
        .then(refresh)
        .catch((e) => setMsg(String(e)));

    return Section(
      "Calls",
      h(
        "div",
        { className: "flex gap-2 mb-4" },
        h(Input, { placeholder: "What should the test call be about?", value: reason, onChange: (e) => setReason(e.target.value) }),
        h(Button, { onClick: call }, "Call me"),
      ),
      msg && h("p", { className: "text-sm mb-2" }, msg),
      calls.length === 0 && h("p", { className: "text-sm text-muted-foreground" }, "No calls yet."),
      ...calls.map((c) =>
        h(
          "div",
          { key: c.id, className: "border-t border-border py-2 text-sm" },
          h(
            "button",
            { className: "w-full text-left", onClick: () => setOpen(open === c.id ? null : c.id) },
            h("span", { className: "font-medium" }, c.direction + " · " + c.status.replace("_", " ")),
            " · " + SDK.utils.timeAgo(c.started_at) + (c.reason ? " · " + c.reason : ""),
          ),
          open === c.id &&
            h(
              "div",
              { className: "mt-2 grid gap-1" },
              c.summary && h("p", { className: "italic" }, c.summary),
              ...c.transcript.map((t, i) => h("p", { key: i }, h("b", null, t.role + ": "), t.text)),
            ),
        ),
      ),
    );
  }

  function Page() {
    const [status, setStatus] = useState(null);
    const [error, setError] = useState(null);
    const refresh = useCallback(() => get("/status").then(setStatus).catch((e) => setError(String(e))), []);

    useEffect(() => {
      refresh();
      const timer = setInterval(refresh, 5000);
      return () => clearInterval(timer);
    }, [refresh]);

    const restart = () =>
      post("/restart")
        .then(() => setTimeout(refresh, 4000))
        .catch((e) => setError(String(e)));

    if (!status) return h("div", { className: "p-4 text-sm" }, error || "Loading…");
    return h(
      "div",
      { className: "mx-auto max-w-3xl p-4" },
      error && h("p", { className: "text-sm text-destructive mb-2" }, error),
      h(Status, { status, onRestart: restart }),
      h(Pair, { linked: !!(status.sidecar && status.sidecar.logged_in) }),
      h(Calls),
      h(Settings, { onSaved: refresh }),
    );
  }

  window.__HERMES_PLUGINS__.register("hermes-whatsapp-voice", Page);
})();
