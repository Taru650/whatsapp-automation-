// Main menu built from the service registry.
//   1 enabled service  -> open that service directly (no one-button menu)
//   2-3 services       -> reply buttons (+ language toggle when there is room)
//   >3 services        -> list message (+ language toggle row)
// Every service must answer the id '<id_prefix>:open' with its own menu.
function tpl(templates, key, lang) {
  const row = (templates || {})[key];
  return row ? row[lang] || row.en || key : key;
}

function openId(service) {
  return `${service.id_prefix}:open`;
}

function buildMainMenu(services, lang, templates) {
  const list = (services || []).slice().sort((a, b) => (a.menu_order - b.menu_order) || a.service_key.localeCompare(b.service_key));
  const title = (s) => (lang === 'hi' ? s.title_hi : s.title_en) || s.title_en;
  const desc = (s) => (lang === 'hi' ? s.description_hi : s.description_en) || '';
  const otherLang = lang === 'hi' ? 'en' : 'hi';
  const langToggle = { id: `lang:${otherLang}`, title: tpl(templates, 'btn_lang_other', lang) };

  if (list.length === 0) {
    return { kind: 'messages', messages: [{ type: 'text', body: tpl(templates, 'error_apology', lang) }] };
  }
  if (list.length === 1) {
    return { kind: 'open_service', service: list[0] };
  }
  if (list.length <= 3) {
    const buttons = list.map((s) => ({ id: openId(s), title: title(s) }));
    if (buttons.length < 3) buttons.push(langToggle);
    return { kind: 'messages', messages: [{ type: 'buttons', body: tpl(templates, 'menu_prompt', lang), buttons }] };
  }
  const rows = list.slice(0, 9).map((s) => ({ id: openId(s), title: title(s), description: desc(s) }));
  rows.push({ id: langToggle.id, title: langToggle.title, description: '' });
  return {
    kind: 'messages',
    messages: [{
      type: 'list',
      body: tpl(templates, 'menu_prompt', lang),
      button: tpl(templates, 'menu_button', lang),
      sections: [{ title: tpl(templates, 'menu_section', lang), rows }],
    }],
  };
}

if (typeof module !== 'undefined') module.exports = { buildMainMenu, tpl, openId };
