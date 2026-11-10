-- Seed data for the core platform. Idempotent (upserts).

-- Runtime switches (defaults only; operators change them with UPDATE).
INSERT INTO core.settings (key, value) VALUES ('llm_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
-- "hi" opens the Sonpur Mela menu directly; the other services (File a
-- Complaint) are rows in it. Set to '' to go back to the 2-button main menu.
INSERT INTO core.settings (key, value) VALUES ('home_service', 'mela')
ON CONFLICT (key) DO NOTHING;
-- "Was this helpful? 👍/👎" after an answer: off, because it is one more
-- WhatsApp message and Meta charges per message. 'true' turns it on (asked at
-- most once per citizen per day).
INSERT INTO core.settings (key, value) VALUES ('feedback_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
-- The first-contact greeting sits on top of the first reply (the menu): one
-- message per new citizen instead of two. 'false' sends it as its own message.
INSERT INTO core.settings (key, value) VALUES ('welcome_in_reply', 'true')
ON CONFLICT (key) DO NOTHING;

-- National emergency numbers the bot may always mention.
SELECT core.register_numbers('static', ARRAY['112', '108', '1098', '1091', '101', '100']);

INSERT INTO core.templates (key, hi, en, max_len) VALUES
  ('welcome_notice',
   E'🙏 नमस्ते! यह सोनपुर मेला की आधिकारिक WhatsApp सेवा है।\n*अतिथि देवो भव* – हरिहर क्षेत्र की पावन धरती पर आपका हार्दिक स्वागत है। आपकी मेला यात्रा सुरक्षित और मंगलमय हो!\n\n_सेवा बेहतर करने के लिए आपका नंबर और संदेश सुरक्षित रखे जाते हैं; आपकी लोकेशन कभी सहेजी नहीं जाती।_',
   E'🙏 Namaste! This is the official Sonpur Mela WhatsApp service.\n*Atithi Devo Bhava* – a warm welcome to the sacred land of Harihar Kshetra. Wishing you a safe and joyful Mela!\n\n_Your number and messages are kept securely to improve the service; your location is never stored._',
   1024),
  ('menu_prompt',        'आप क्या जानना चाहते हैं? नीचे से चुनें।', 'What would you like to know? Please choose below.', 1024),
  ('menu_button',        'सेवाएँ', 'Services', 20),
  ('menu_section',       'सेवाएँ', 'Services', 24),
  ('unsupported',        'माफ़ कीजिए, मैं अभी केवल लिखे हुए संदेश और बटन समझ सकता हूँ। कृपया टाइप करें या मेनू से चुनें।',
                         'Sorry, I can only understand typed messages and button taps for now. Please type or choose from the menu.', 1024),
  ('unsupported_flow',   'माफ़ कीजिए, मैं इस तरह का संदेश नहीं पढ़ सकता। कृपया ऊपर वाले चरण को जारी रखें – जवाब लिखकर भेजें या बटन दबाएँ।',
                         'Sorry, I can''t read this kind of message. Please continue with the step above – type your answer or tap a button.', 1024),
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
        999, false, 'SvcEcho000000001',   -- test-only; enable per test (never in production)
        'Test service: the user explicitly asks to test or echo something.',
        'परीक्षण सेवा', '{"repeat": "repeat the user text back"}', ARRAY['echo', 'test'])
ON CONFLICT (service_key) DO UPDATE SET
    id_prefix = EXCLUDED.id_prefix, title_hi = EXCLUDED.title_hi, title_en = EXCLUDED.title_en,
    description_hi = EXCLUDED.description_hi, description_en = EXCLUDED.description_en,
    workflow_id = EXCLUDED.workflow_id, intent_hint_en = EXCLUDED.intent_hint_en,
    intent_hint_hi = EXCLUDED.intent_hint_hi, subtypes = EXCLUDED.subtypes, keywords = EXCLUDED.keywords;
