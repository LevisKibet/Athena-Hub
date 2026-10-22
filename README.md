# Athena Hub


## Kenya @ 50

Team party game: `kenya-50.html` + `k50.js` + `k50.css`. Rules live in Supabase.

Setup (Supabase SQL Editor, in order):
1. `supabase/kenya50/schema.sql` (drops and recreates all `k50_*` tables; does not touch Kahoot `qa_*`)
2. `supabase/kenya50/seed_cards.sql` (100 cards: 50 red, 50 black)
3. Add the page URL to Auth > URL Configuration > Redirect URLs (host sign-in is a magic link).

The host signs in and creates a game; players join with the room code or QR and a nickname.
