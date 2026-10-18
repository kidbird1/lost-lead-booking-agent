# Plan V2: From Missed-Call Catcher to Receptionist

**Log line:** We sell "never lose a missed call again". What we deliver is a receptionist that answers, checks the caller is local, and gets the job to the owner or onto the calendar.

## Mindset

1. **Sell the pain, deliver more.** Marketing says "missed calls". The product quietly does receptionist work.
2. **The owner does nothing new.** No new app and no dashboard. WhatsApp only.
3. **You do nothing per call.** You only show up for setup and for problems the system flags to you.
4. **Built for the world, sold narrow.** The code works in any country. Marketing starts with one trade in one country, then widens.
5. **Every failure has to be loud.** If something breaks silently (like the no-voice test call), it doesn't count as robust.

## Three options

### Option 1: Lead Catcher Pro
The agent answers, checks the caller is inside the service area, asks trade-specific questions, and the owner gets the WhatsApp. The owner calls back to book.
- **Good:** works for every trade and every country, with nothing to connect per client.
- **Bad:** nothing gets booked automatically. The owner still has to call back.

### Option 2: Full Receptionist (books on the calendar)
Same as Option 1, plus the agent checks the owner's calendar live and books a real time slot during the call.
- **Calendly:** its API is mainly for reading. Booking through it needs a paid plan and extra setup, so it's a poor fit.
- **Cal.com:** free, with a real booking API. The agent can see open times and book them.
- **Good:** the caller hangs up with an appointment, which is the strongest selling point.
- **Bad:** every client needs a Cal.com calendar. Emergency trades (plumbing leak, car lockout) don't want a calendar slot; they want a callback in the next few minutes.

### Option 3: Catcher + Booking Add-on (CHOSEN)
Everyone gets Option 1. Clients who work by appointment (solar, HVAC tune-ups, mechanics, cleaners) can also connect a free Cal.com calendar, and then the agent books during the call.
- **Emergencies** (leak, lockout, no heat): "The team will call you right back," and the owner gets an URGENT WhatsApp.
- **Planned jobs**, if the client has a calendar: the agent offers 2-3 open times and books one.
- **Outside the service area:** the agent politely declines. The owner isn't bothered, and the call is logged.
- **Why it's the pick:** it fits every trade, gives two price tiers (Catcher, and Catcher + Booking), and the first part works the same day a client signs up.

## Build order

**Part A: now (makes the core robust)**
1. **Service-area check, any country.** Each client gets a home base and a radius. During the call the agent checks the caller's address with a free world map lookup (OpenStreetMap). Inside = continue. Outside = polite no.
2. **Trade presets.** Plumber, HVAC, electrician, locksmith, mechanic/towing, solar, roofer, cleaner, pest, general. Each preset has its own questions and its own sense of what counts as urgent.
3. **Country and time zone per client.** Times are spoken and sent in the client's own time zone.
4. **Watchdogs.** You get a WhatsApp if a client gets no calls for 3 days, if a call hits Vapi but never reaches us, or if alerts keep failing. Turn on **auto-reload** in Vapi billing so calls never die from running out of credit.
5. **Automatic test scenarios.** A script runs pretend callers through the real agent by text: local plumber job, New York caller to a Florida plumber, locked-out driver, solar lead. It checks each one ends up right.

**Part B: after A passes**
6. Cal.com booking add-on.
7. Stripe billing: non-paying clients get paused automatically.

## Going global: what's different

- **Phone numbers:** Vapi's own numbers are US-only. For Australia, New Zealand, the UK and so on, buy a local number in Twilio (some countries ask for ID papers) and connect it. The code already supports this (`twilio_number`).
- **WhatsApp:** it's bigger outside the US, so that's a plus.
- **Language:** English-speaking countries work as they are. Other languages are a later preset.
- **Marketing:** start with US plumbers (see MARKETING-PLAN.md). The product can take clients anywhere, but your message should stay narrow until it works.
