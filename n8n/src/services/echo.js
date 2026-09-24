// svc_echo: dummy service that proves the plug-in contract end to end (M0).
// It repeats what the citizen types. Disabled in production from M1 onwards.
const ECHO_TEXT = {
  hi: { intro: 'इको टेस्ट सेवा: कुछ भी लिखें, मैं वही दोहराऊँगा।', said: 'आपने लिखा', nothing: 'अभी तक कुछ नहीं लिखा गया।', again: '🔁 फिर से', menu: '🏠 मेनू' },
  en: { intro: 'Echo test service: type anything and I will repeat it.', said: 'You said', nothing: 'Nothing typed yet.', again: '🔁 Repeat', menu: '🏠 Menu' },
};

function echoHandle(req) {
  const L = ECHO_TEXT[req.lang] || ECHO_TEXT.en;
  const input = req.input || {};
  const ctx = req.context || {};
  const buttons = [{ id: 'echo:again', title: L.again }, { id: 'core:menu', title: L.menu }];
  if (input.kind === 'open' || input.id === 'echo:open') {
    return { messages: [{ type: 'buttons', body: L.intro, buttons }], next_state: 'echo.wait', context: ctx, done: false, log: { subtype: 'open', resolved: true } };
  }
  if (input.id === 'echo:again') {
    const body = ctx.last ? `${L.said}: ${ctx.last}` : L.nothing;
    return { messages: [{ type: 'buttons', body, buttons }], next_state: 'echo.wait', context: ctx, done: !!ctx.last, log: { subtype: 'repeat', resolved: !!ctx.last } };
  }
  if (input.kind === 'text' && input.text) {
    return {
      messages: [{ type: 'buttons', body: `${L.said}: ${input.text}`, buttons }],
      next_state: 'echo.wait', context: { ...ctx, last: input.text }, done: true,
      log: { subtype: (input.intent && input.intent.subtype) || 'repeat', resolved: true },
    };
  }
  return { messages: [{ type: 'buttons', body: L.intro, buttons }], next_state: 'echo.wait', context: ctx, done: false, log: { subtype: 'open', resolved: true } };
}

if (typeof module !== 'undefined') module.exports = { echoHandle };
