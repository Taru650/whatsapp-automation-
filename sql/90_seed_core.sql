-- Seed data for the core platform. Idempotent (upserts).

-- Runtime switches (defaults only; operators change them with UPDATE).
INSERT INTO core.settings (key, value) VALUES ('llm_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

-- National emergency numbers the bot may always mention.
SELECT core.register_numbers('static', ARRAY['112', '108', '1098', '1091', '101', '100']);

INSERT INTO core.templates (key, hi, en, max_len) VALUES
  ('welcome_notice',
   'नमस्ते! यह सारण ज़िला प्रशासन की WhatsApp सेवा है। सेवा बेहतर करने के लिए आपका नंबर और संदेश सुरक्षित रूप से सहेजे जाते हैं; आपकी लोकेशन कभी सहेजी नहीं जाती।',
   'Namaste! This is the Saran District Administration WhatsApp service. Your number and messages are stored securely to improve the service; your location is never stored.',
   1024),
  ('menu_prompt',        'आप क्या जानना चाहते हैं? नीचे से चुनें।', 'What would you like to know? Please choose below.', 1024),
  ('menu_button',        'सेवाएँ', 'Services', 20),
  ('menu_section',       'सेवाएँ', 'Services', 24),
  ('unsupported',        'माफ़ कीजिए, मैं अभी केवल लिखे हुए संदेश और बटन समझ सकता हूँ। कृपया टाइप करें या मेनू से चुनें।',
                         'Sorry, I can only understand typed messages and button taps for now. Please type or choose from the menu.', 1024),
  ('rate_limited',       'आप बहुत तेज़ी से संदेश भेज रहे हैं। कृपया कुछ मिनट बाद फिर कोशिश करें।',
                         'You are sending messages very quickly. Please try again in a few minutes.', 1024),
  ('error_apology',      'माफ़ कीजिए, कुछ गड़बड़ हो गई। कृपया दोबारा कोशिश करें या "मेनू" लिखें।',
                         'Sorry, something went wrong. Please try again or type "menu".', 1024),
  ('not_understood',     'माफ़ कीजिए, मैं समझ नहीं पाया। कृपया मेनू से चुनें।',
                         'Sorry, I did not understand that. Please choose from the menu.', 1024),
  ('feedback_prompt',    'क्या यह जानकारी उपयोगी थी?', 'Was this helpful?', 1024),
  ('feedback_thanks',    'धन्यवाद! आपकी राय से हमें सेवा बेहतर करने में मदद मिलती है।',
                         'Thank you! Your feedback helps us improve the service.', 1024),
  ('lang_switched',      'भाषा बदल दी गई: हिंदी', 'Language changed: English', 1024),
  ('not_allowed',        'यह विकल्प आपके लिए उपलब्ध नहीं है।', 'This option is not available to you.', 1024),
  ('btn_helpful',        '👍 उपयोगी', '👍 Helpful', 20),
  ('btn_not_helpful',    '👎 उपयोगी नहीं', '👎 Not helpful', 20),
  ('btn_menu',           '🏠 मेनू', '🏠 Menu', 20),
  ('btn_lang_other',     '🌐 English', '🌐 हिंदी', 20)
ON CONFLICT (key) DO UPDATE SET hi = EXCLUDED.hi, en = EXCLUDED.en, max_len = EXCLUDED.max_len;

-- svc_echo: dummy service proving the plug-in contract (M0). Disabled in
-- production once svc_mela is enabled (M1).
INSERT INTO core.services (service_key, id_prefix, title_hi, title_en, description_hi, description_en,
                           menu_order, enabled, workflow_id, intent_hint_en, intent_hint_hi, subtypes, keywords)
VALUES ('echo', 'echo', 'इको टेस्ट', 'Echo test', 'परीक्षण सेवा', 'Test service',
        999, true, 'SvcEcho000000001',
        'Test service: the user explicitly asks to test or echo something.',
        'परीक्षण सेवा', '{"repeat": "repeat the user text back"}', ARRAY['echo', 'test'])
ON CONFLICT (service_key) DO UPDATE SET
    id_prefix = EXCLUDED.id_prefix, title_hi = EXCLUDED.title_hi, title_en = EXCLUDED.title_en,
    description_hi = EXCLUDED.description_hi, description_en = EXCLUDED.description_en,
    workflow_id = EXCLUDED.workflow_id, intent_hint_en = EXCLUDED.intent_hint_en,
    intent_hint_hi = EXCLUDED.intent_hint_hi, subtypes = EXCLUDED.subtypes, keywords = EXCLUDED.keywords;
