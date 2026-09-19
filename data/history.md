# Sonpur Mela — History & General Information

> Sourced via web search against the official Saran district government
> site (saran.nic.in), Wikipedia's Sonepur Cattle Fair article, and
> several travel/news sources — cross-checked across multiple independent
> sources where possible. General historical/geographic facts are stable
> and low-risk. The one date-sensitive fact (this year's Mela dates) is
> current as of when this was written (September 2026) — reconfirm closer
> to the event since dates shift every year with the lunar calendar.
> Sources are listed at the end of each section.

## Overview

Sonpur Mela (also called Sonepur Mela or the Harihar Kshetra Mela) is a
month-long fair held every year at Sonpur, in Saran district, Bihar, at
the confluence of the Ganga and Gandak rivers — a site known as Harihar
Kshetra. It is traditionally described as Asia's largest cattle fair, and
combines livestock trading, a large shopping bazaar, cultural
performances, and religious observance around the Harihar Nath Temple.
The fair opens on Kartik Purnima (the full moon of the Hindu month of
Kartik) and traditionally runs for around a month.

Source: [saran.nic.in — About Sonepur Mela](https://saran.nic.in/about-sonepur-mela/), [Wikipedia — Sonepur Cattle Fair](https://en.wikipedia.org/wiki/Sonepur_Cattle_Fair)

## History

The fair's origins are traditionally traced back to the later Vedic age,
when it is said to have attracted traders from as far as Central Asia.
Popular tradition connects it to the Mauryan period, when Emperor
Chandragupta Maurya is said to have purchased elephants and horses here
for his army. A British administrative officer, W. W. Hunter, recorded in
his travelogue that the fair historically drew participation from over 43
villages.

The site's religious significance centers on the Harihar Nath Temple at
Sonpur, dedicated to a combined form of Vishnu and Shiva (Hari-Hara), and
one associated legend describes Lord Vishnu intervening to end a
mythological battle between an elephant (Gaj) and a crocodile (Grah),
symbolising forest and water. The temple is traditionally said to have
originally been built by Lord Rama en route to King Janak's court.

Source: [saran.nic.in — About Sonepur Mela](https://saran.nic.in/about-sonepur-mela/), [The Diplomat — A Carnival on the City's Margins: The Sonepur Mela of Bihar](https://thediplomat.com/2020/06/a-carnival-on-the-citys-margins-the-sonepur-mela-of-bihar/)

## Dates & Duration (2026)

The 2026 Sonpur Mela is expected to begin on **24 November 2026**
(Kartik Purnima) and run for about a month, through roughly
**23 December 2026**. Exact program dates and daily schedules are
published closer to the event by the Saran district administration —
confirm against their official announcements before publishing this to
the public, since exact closing dates and any schedule changes are set by
the district administration each year.

Source: [Sonpur Mela 2026 — Aajkapanchangs](https://aajkapanchangs.in/sonpur-mela-2026-kab-hai-dates/), [Holidify — Sonepur Mela 2026](https://www.holidify.com/pages/sonepur-mela-4716.html)

## What's on offer

- **Livestock trading**: cattle, horses, and other animals are traded by
  merchants from across India. Note: elephant *trading* has been
  prohibited at the Mela since 2004 under the Wildlife Protection Act,
  1972, though the historic "Haathi Bazaar" (Elephant Bazaar) grounds
  remain a named site and viewing attraction.
- **Shopping and handicrafts**: a large bazaar sells garments, furniture,
  toys, utensils, agricultural implements, jewelry, and handicrafts.
- **Cultural programs**: folk music and dance performances, magic shows,
  acrobats, and circus-style entertainment run throughout the fair.
- **Religious observance**: Hindu pilgrims take a ritual dip at the
  Ganga-Gandak confluence and offer prayers at the Harihar Nath Temple,
  particularly on Kartik Purnima itself.

Source: [Wikipedia — Sonepur Cattle Fair](https://en.wikipedia.org/wiki/Sonepur_Cattle_Fair), [Caleidoscope — Sonepur Cattle Fair: A Celebration of Tradition and Trade](https://caleidoscope.in/art-culture/sonepur-cattle-fair)

## Getting there

- **By rail**: Sonpur has its own station, Sonpur Junction, with
  connections across India. The nearest major hub is Patna, about 27 km
  away (under an hour by road); Hajipur Junction is the closest major
  station, with Sonpur typically the very next stop on lines through
  Hajipur, only a few kilometres away.
- **By road**: from Hajipur (about 5 km away) or Patna, buses, taxis,
  autos, and (locally) tongas run to the Mela grounds.

Source: [RailMitra — Sonpur Mela Complete Guide](https://www.railmitra.com/blog/sonpur-mela-complete-guide-to-asias-largest-cattle-fair), [saran.nic.in — How To Reach](https://saran.nic.in/mela-how-to-reach/)

## Facilities for visitors

TODO: General visitor facilities (drinking water points, a lost-and-found
desk if one exists, cloakrooms) were not found via web search in enough
verified detail to publish here — these tend to be announced fresh each
year rather than documented on a stable page. Pull this from the
district administration's current-year Mela notification closer to the
event. (Emergency/administrative contacts, accommodation, and parking —
police, medical, veterinary, control room, hotels/camps, vehicle parking
— live separately in `data/facilities.csv`, not here, since those are
structured lookups rather than free-text answers.)

## Daily program & special attractions

Day-by-day cultural program schedules (morning/evening events, and which
day's headline performer is the "special attraction") live in
`data/program_schedule.csv`, not here — that data is date-indexed and
needs an exact "what's happening today" lookup rather than a semantic
text search, so it's handled by a separate direct-lookup path in the n8n
workflow instead of this RAG-retrieved history text. As of when this was
written (~2 months before the 2026 Mela), no official day-by-day lineup
had been published yet — `program_schedule.csv` currently holds only
placeholder rows for pipeline testing. Replace them once the district
administration/Art & Culture department publishes the real schedule,
typically closer to the event.

## Prohibited / banned items

**Not confirmed as Sonpur Mela's official list.** Web search found that
`saran.nic.in`'s 2025 Mela page references a dedicated "Banned Lists"
section, but the page itself is unreachable for direct fetch from this
environment, so its actual contents couldn't be verified. Do not present
the list below to the public as Sonpur-specific — it's included only as
context for what comparable large Indian mela-scale/fair events commonly
restrict, cited to those other events:

- Weapons/arms, except for on-duty security personnel (common at
  comparable fairs such as the Surajkund Craft Fair).
- Unmanned aerial vehicles / drones flown by the public (banned at
  Surajkund Craft Fair and widely restricted at other large Indian public
  gatherings for security reasons).
- Large public gatherings/assemblies beyond a stated limit, when a
  prohibitory order (Section 163 BNS / erstwhile Section 144 CrPC) is in
  force for the event — common practice at Indian mela-scale events,
  not confirmed specifically for Sonpur.

Source: [Tribune India — Surajkund Craft Fair security measures, drones banned](https://www.tribuneindia.com/news/haryana/surajkund-craft-fair-to-be-organised-under-stringent-security-measures-drones-banned/) (an analogous fair, not Sonpur itself)

**Action needed before this goes live**: get the actual Sonpur Mela
banned-items list from `saran.nic.in`'s Banned Lists section or the
district administration directly, and replace this section entirely —
telling a visitor something is fine to carry when it's actually banned
(or vice versa) is a real problem, not a stylistic one.
