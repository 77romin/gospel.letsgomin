# 무료 배포 절차

이 문서는 `gospel.letsgomin.com`을 Vercel Hobby와 Supabase Free에 배포하는 순서입니다. WordPress Lightsail은 건드리지 않습니다.

## 1. Supabase 데이터베이스 준비

1. Seoul 프로젝트의 **SQL Editor → New query**에서 [`supabase/setup.sql`](supabase/setup.sql) 전체를 실행합니다.
2. 이 파일 맨 끝에는 현재 지휘자 계정의 User UID가 들어 있습니다. 다른 Supabase 프로젝트에 실행하려면 UID를 바꿔야 합니다.
3. **Table Editor**에 `choir_state`, `choir_segments`, `choir_conductors`가 생겼는지 확인합니다.
4. 기존 로컬 연습 구간 두 개를 보존하려면 [`supabase/import-segments.sql`](supabase/import-segments.sql)도 SQL Editor에서 실행합니다.
5. **Authentication → Users**에서 지휘자 사용자가 확인된 이메일을 가지고 있는지 확인합니다. 로그인에는 이메일과 비밀번호를 사용합니다.

## 2. 로컬 빌드 확인

프로젝트 URL과 Publishable key는 브라우저에서 쓰는 공개 키입니다. Secret key와 DB 비밀번호는 이 앱에 사용하지 않습니다.

```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY \
npm run build
```

`npm start`는 기존 로컬 Node 서버를 실행합니다. Vercel은 `npm run build`가 만든 `dist` 폴더를 서비스합니다.

## 3. GitHub에 코드 반영

먼저 `dev` 브랜치에서 자동 테스트와 MacBook·iPhone 실기기 테스트를 마칩니다. 결과가 만족스러울 때만 `main`에 병합하고 `git push origin main` 합니다. 영상과 별도 디코딩용 음원이 저장소에 포함돼 있습니다.

## 4. Vercel 프로젝트 만들기

1. Vercel의 **Add New → Project**에서 GitHub 저장소 `77romin/gospel.letsgomin`을 가져옵니다.
2. **Framework Preset: Other**, **Root Directory: `./`**, **Build Command: `npm run build`**, **Output Directory: `dist`**로 설정합니다.
3. **Environment Variables**에 다음 두 항목을 Production 환경으로 추가합니다.

   - `VITE_SUPABASE_URL` = Supabase Project URL
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = Supabase Publishable key

4. 배포 후 `*.vercel.app` 주소에서 개인 재생, 지휘자 로그인과 구간 추가, 다른 브라우저의 구간 조회를 확인합니다.

## 5. Route 53 서브도메인 연결

1. Vercel 프로젝트의 **Settings → Domains**에 `gospel.letsgomin.com`을 추가합니다.
2. Vercel이 제시하는 CNAME 대상을 복사합니다. 프로젝트마다 다를 수 있으므로 임의 주소를 입력하지 않습니다.
3. Route 53의 기존 `letsgomin.com` 호스팅 영역에 `gospel` 이름의 **CNAME** 레코드를 추가하고 값을 붙여 넣습니다.
4. Vercel에서 도메인과 HTTPS 상태가 유효해질 때까지 기다립니다. WordPress의 기존 A 레코드와 네임서버는 변경하지 않습니다.

## 운영상 주의

기존 Supabase 프로젝트에서 같이 연습을 시험하기 전에 **SQL Editor → New query**에 [`supabase/three-second-countdown.sql`](supabase/three-second-countdown.sql) 전체 내용을 붙여 넣고 실행합니다. 이 파일은 기존 곡과 연습 구간을 유지하면서 재생·정지·재생 중 위치 이동을 3초 뒤 공통 시각에 실행하도록 상태와 함수를 갱신합니다.

- Supabase Free 프로젝트는 1주일간 활동이 없으면 일시 중지될 수 있습니다.
- 공동 재생을 다시 켤 경우 지휘자가 참여 해제·혼자 연습 전환·로그아웃을 하면 공동 재생이 즉시 멈춥니다. 인터넷 연결이 갑자기 끊기면 최대 약 30초 후 참여 기한이 만료되어 멈춥니다.
- `public/tracks.json`의 곡 ID나 길이를 바꾸면 Supabase `choir_state`의 `song_id`, `duration_sec`도 맞춰야 합니다.
- 음원은 Vercel 정적 파일로 제공됩니다. 무료 전송량을 확인하세요.
