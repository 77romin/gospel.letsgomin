-- Existing practice sections from the local data/state.json.
-- Safe to run more than once.
insert into public.choir_segments (id, song_id, label, start_sec, end_sec, color, highlighted, checked)
values
  ('1a445ace-3147-4313-93e9-4ec3071dfe4a', 'navigator', '1절', 30.836951219512198, 54.9529512195122, '#e50af5', false, false),
  ('5d3514a0-7b7f-4a09-92f3-ac09ec12eb8f', 'navigator', '2절', 55.2394512195122, 80.7724512195122, '#e7eb0f', false, false),
  ('085cb18f-a03c-4f86-9cf4-4ef8c3039f4a', 'navigator', '후렴', 80.96069, 125.69662, '#100ce4', false, false),
  ('7d271d44-86e9-4fa4-adae-750c532a11dc', 'navigator', '3절', 145.793279, 168.021329, '#0bf49e', false, false),
  ('591b5bd0-6c98-4f1c-8d29-d4ddd5e775a9', 'navigator', '4절', 168.186138, 192.894858, '#ffa50a', false, false),
  ('148474eb-fb5f-441b-93f1-ca4a49e9f361', 'navigator', '후렴', 192.933518, 256.568058, '#ef0119', false, false)
on conflict (id) do update set
  label = excluded.label,
  start_sec = excluded.start_sec,
  end_sec = excluded.end_sec,
  color = excluded.color,
  highlighted = excluded.highlighted,
  checked = excluded.checked;
