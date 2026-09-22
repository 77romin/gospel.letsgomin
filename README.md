# Gospel Choir Practice

교회 성가대의 다섯 파트 연습용 프로토타입입니다. 지휘자만 공통 재생 위치와 연습 구간을 조작하고, 청취자는 선택한 파트의 음원만 듣습니다.

## 로컬 실행

1. `npm install`
2. PowerShell에서 `$env:CONDUCTOR_PASSWORD='충분히-긴-비밀번호'` 설정
3. `npm start`
4. `http://localhost:3000` 접속. 지휘자 아이디는 `conductor`입니다.

비밀번호를 설정하지 않으면 서버가 실행 때마다 임시 비밀번호를 터미널에 출력합니다. `npm test`로 권한, 동기 상태, 음원 제공, 구간 변경을 확인할 수 있습니다.

## GitHub 저장소에서 음원 교체

1. 다섯 파트의 음원 파일을 [`public/audio`](public/audio)에 추가합니다. 현재는 Navigator의 MP4 다섯 파일을 연결했습니다. 화면은 선택한 파트의 소리만 재생합니다.
2. [`public/tracks.json`](public/tracks.json)의 `id`, `title`, 각 파트의 `file` 경로와 `durationSec`를 수정합니다. 경로 예: `/audio/choir.mp3` 또는 `/audio/choir.mp4`.
3. 다섯 파일의 시작점과 길이를 같게 맞춥니다. 시작 부분의 무음도 일치해야 합니다.
4. 코드와 음원을 함께 GitHub에 커밋합니다. 현재 Node 서버를 사용할 때는 파일 변경 후 서버를 재시작해야 합니다. `id`를 바꾸면 이전 곡의 구간 표시 상태가 초기화됩니다.

현재 Navigator 구간 표시는 비워 두었으므로 지휘자가 곡에 맞게 추가할 수 있습니다. 원본 `data/media`는 Git에 포함되지 않으며 배포 파일은 `public/audio`에 있습니다. 페이지에는 음원 업로드 기능이 없습니다. 지휘자는 재생·일시정지·건너뛰기와 구간 강조·완료 표시만 조작합니다.

## 공개 배포 전에 필요한 것

**GitHub Pages에 파일만 올리고 도메인을 연결해서는 실시간 재생 기능이 작동하지 않습니다.** `server.js`가 지휘자 인증과 WebSocket 동기화를 담당하기 때문입니다. 공개하려면 실시간 서버를 별도로 배포하거나 Cloudflare Pages Functions와 Durable Object로 옮겨야 합니다. 이후 Route 53에서 `gospel.letsgomin.com`을 배포 주소에 연결합니다.

`CONDUCTOR_PASSWORD`를 GitHub에 올리지 마세요. 현재 구간 상태는 Git에 포함되지 않는 `data/state.json`에 저장되며, 서버가 재시작되면 재생은 정지되고 로그인 세션도 만료됩니다. 공개 운영 전에는 HTTPS, 운영용 인증, 상태 백업을 마련해야 합니다.
