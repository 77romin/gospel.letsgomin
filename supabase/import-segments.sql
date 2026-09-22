-- Existing practice sections from the local data/state.json.
-- Safe to run more than once.
insert into public.choir_segments (id, song_id, label, start_sec, end_sec, color, highlighted, checked)
values
  ('1a445ace-3147-4313-93e9-4ec3071dfe4a', 'navigator', 'verse1', 30.836951219512198, 54.9529512195122, '#6b9f8c', false, false),
  ('5d3514a0-7b7f-4a09-92f3-ac09ec12eb8f', 'navigator', 'verse2', 55.2394512195122, 80.7724512195122, '#e7eb0f', false, false)
on conflict (id) do nothing;
