# Sonpur Mela bot – data entry guide / डेटा भरने की गाइड

For the Mela data owner and staff who update the Google Sheet.
यह गाइड मेला डेटा के ज़िम्मेदार अधिकारी और शीट भरने वाले कर्मचारियों के लिए है।

## 1. What citizens see / नागरिक क्या देखते हैं
Everything the bot says about the Mela comes **only** from this sheet: thana,
health centres, vet camps, parking, ghats, control room, programme. If a
number is wrong in the sheet, it is wrong on WhatsApp.
बॉट मेले के बारे में जो भी बताता है, वह **सिर्फ़** इसी शीट से आता है। शीट में
नंबर गलत है तो WhatsApp पर भी गलत जाएगा।

## 2. Tabs / टैब
| Tab | One row = / एक पंक्ति = |
|---|---|
| `places` | one thana / health centre / vet camp / parking / ghat (the `category` column says which) · एक थाना / स्वास्थ्य केंद्र / पशु शिविर / पार्किंग / घाट |
| `control_room` | one desk: Magistrate, Police, Sanitation & Water, Electricity, Health · एक डेस्क |
| `events` | one programme item (a day can have several) · एक कार्यक्रम |
| `guidelines` | one do / don't / emergency instruction (optional) · एक निर्देश |
| `settings` | shift start times, **public helpline number**, Mela centre point · पाली का समय, **हेल्पलाइन नंबर**, मेला केंद्र |

## 3. Shift columns / पाली कॉलम
`s1_…`, `s2_…`, `s3_…` = the person on duty in shift 1, 2, 3. The shift times
are set in `settings` (06:00, 14:00, 22:00). If the **same person is on duty
all day** (e.g. a vet camp doctor), use `allday_name` / `allday_phone`
instead. The bot shows citizens only **who is on duty right now**.
`s1/s2/s3` = पहली/दूसरी/तीसरी पाली में ड्यूटी वाला व्यक्ति। पूरे दिन वही व्यक्ति
हो तो `allday_name` / `allday_phone` भरें। बॉट नागरिक को सिर्फ़ **अभी ड्यूटी पर**
व्यक्ति दिखाता है।

## 4. Rules that cause a rejection / ये गलतियाँ सिंक रोक देती हैं
The sheet is checked every 10 minutes. If there is **any** of these errors,
the bot keeps the old data and the admins get a WhatsApp message naming the
tab and row:
शीट हर 10 मिनट में जाँची जाती है। नीचे की कोई भी गलती हो तो बॉट पुराना डेटा रखता
है और एडमिन को टैब और पंक्ति नंबर के साथ संदेश जाता है:

- **Phone:** it must be a 10-digit mobile (e.g. `9431012345`) or a landline
  with its STD code and 0 (e.g. `06152-240001`). `709095094` (9 digits) is
  rejected. Put one number per cell; a second number goes in `phone_2`.
  **फ़ोन:** 10 अंकों का मोबाइल या STD कोड सहित लैंडलाइन। एक सेल में एक नंबर।
- **Hindi typed in Kruti Dev** (it looks like `¼u[kk'k½`). Type Hindi in
  Unicode with Google Input Tools or the Windows Hindi keyboard.
  **Kruti Dev में हिंदी** (जैसे `¼u[kk'k½`) – यूनिकोड में टाइप करें।
- A duplicate `id`, a missing `category`, or a date that isn't
  `2026-11-24` / `24/11/2026`.
- Latitude/longitude outside India. For Sonpur these look like
  `25.69` / `85.17`; check that they are not swapped.
- Test text: `DUMMY-TEST-DATA`, `PLACEHOLDER` or `TODO`.

## 5. Verified tick / verified टिक
In production **only rows with `verified = TRUE` reach citizens**. Tick it
only after calling the number or checking it against the duty order.
Unticked rows are left out, and the daily message says how many.
प्रोडक्शन में **सिर्फ़ `verified = TRUE` वाली पंक्तियाँ** नागरिकों तक जाती हैं।
नंबर पर फ़ोन करके या ड्यूटी आदेश से मिलाकर ही टिक करें।

## 6. Duty changes during the Mela / मेले के दौरान ड्यूटी बदलना
Edit the name and phone **on the same row**. Never add a second row for the
same place. The bot shows the change within 10 minutes. To hide a place,
set `active = FALSE`; don't delete the row.
उसी पंक्ति में नाम/फ़ोन बदलें, नई पंक्ति न जोड़ें। 10 मिनट में बदलाव दिखेगा।
जगह छिपानी हो तो `active = FALSE` करें।

## 7. Pinning locations on site (“Near me”) / मौके पर लोकेशन पिन करना
Do this in the set-up week, once the camps and thanas are standing. It
takes about one day for all sites.
सेट-अप सप्ताह में, जब थाना/शिविर खड़े हो जाएँ (सभी जगहों के लिए लगभग एक दिन)।

1. Your number must be in the admin list (ask the technical owner).
2. On WhatsApp, send **pin** to the bot, then pick the category and the site
   you are standing at.
3. Stand at the site's **entrance** and tap **Send location**.
4. Check the pin on the map, then tap **✅ Save**. Tap **Next site** to go on.
5. Send **pin status** to see progress (e.g. "Police stations: 11/14 pinned").

A lat/lon typed into the sheet always overrides a pinned point, which is
useful for correcting one. Until a category has pinned sites, "Near me" is
hidden for it and citizens see the full list instead.
शीट में लिखा lat/lon पिन किए गए बिंदु से ऊपर माना जाता है (सुधार के लिए)।

## 8. Getting started with the converted sample / शुरुआत
`data/templates/Sonpur_Mela_Bot_Data.xlsx` already holds your 2025 data in
this format:
- 14 thanas, 5 health centres, 11 vet camps, 18 parking areas, 6 ghats
- the control room desks
- 14 programme days

To use it:
1. Upload it to Google Drive and choose **Open with Google Sheets**.
2. Share it with the bot's service-account e-mail as a **Viewer**, or as an
   **Editor** so pinned points are written back to the sheet.
3. Fix what the check reports:
   - the 9-digit phone in `places` row 14
   - the empty `public_helpline_1`
   - the Mela centre point
   - the 2026 programme
4. Verify every row.
