# 같이 연습 오디오 레이턴시 트러블슈팅

## 1. 문제와 재현 환경

`같이 연습`은 지휘자의 재생 명령을 여러 기기가 동시에 받아 같은 곡 위치를 재생하는 기능이다. 초기 구현은 서버 상태와 `<video>.currentTime`을 맞추는 방식이었다. MacBook Air 내장 스피커와 iPhone 내장 스피커로 시험했을 때 iPhone에서 들리는 소리가 약 0.5초 늦었다. 초기 버전에서는 약 2초까지 차이가 나거나, 위치 보정을 반복하면서 음악이 끊기는 현상도 있었다.

문제의 핵심은 화면에 표시되는 재생 위치와 실제 스피커에서 소리가 나오는 시각이 같지 않다는 점이었다.

1. 네트워크 명령 도착 시각은 기기마다 다르다.
2. `setTimeout()`과 `HTMLMediaElement.play()`는 브라우저 메인 스레드와 버퍼링 상태의 영향을 받는다.
3. MP4의 네트워크 로딩·컨테이너 분석·오디오 디코딩이 재생 버튼을 누른 뒤 발생할 수 있다.
4. 브라우저가 재생을 시작했다고 알려도 오디오 그래프와 운영체제 출력 버퍼를 거쳐 실제 스피커에 도달하기까지 시간이 더 걸린다.
5. Bluetooth 이어폰은 A2DP 버퍼와 출력 경로 재협상 때문에 내장 스피커보다 지연과 변동 폭이 커질 수 있다.

따라서 “명령을 동시에 전송”하거나 “`currentTime`을 같은 값으로 설정”하는 것만으로는 실제 출력음을 맞출 수 없었다.

## 2. 실패했거나 불완전했던 접근

### 재생 중 `currentTime` 반복 보정

서버 기준 위치와 로컬 미디어 위치가 벌어질 때마다 `currentTime`을 옮겼다. 숫자는 가까워졌지만 디코더가 계속 seek하면서 끊김이 발생했다. 이후 재생·정지·위치 이동처럼 transport revision이 바뀔 때만 동기화하도록 수정했다.

### `playing`·`seeked` 이벤트 뒤 한 번 보정

브라우저가 준비됐다고 알린 뒤 현재 위치를 한 번 맞추면 네트워크·로딩 지연 일부는 줄일 수 있었다. 하지만 이벤트는 “실제 스피커에서 첫 샘플이 들린 시각”이 아니므로 iPhone과 MacBook의 출력 차이는 남았다.

### 짧은 배속 재생

뒤처진 기기의 `playbackRate`를 잠시 올려 따라잡게 하는 방식을 시험했다. 음악의 음질과 박자가 흔들리고 최초 출력 지연을 해결하지 못해 채택하지 않았다.

### 기종별 고정 보정값

`iPhone +500ms`, `AirPods +Nms` 같은 테이블은 브라우저 버전, 기기 부하, 출력 장치와 연결 상태에 따라 값이 달라 유지하기 어렵다. 제품 요구와도 맞지 않아 사용하지 않았다.

## 3. 참고한 오픈소스: BeatSync

[freeman-jiang/beatsync](https://github.com/freeman-jiang/beatsync)는 여러 브라우저에서 고정밀 오디오 재생을 맞추는 MIT 라이선스 프로젝트다. 프로젝트 전체를 가져오지 않고 다음 설계 원칙을 참고했다. 확인 기준은 BeatSync 커밋 [`94c38ab`](https://github.com/freeman-jiang/beatsync/tree/94c38ab16ec861835ce0b4bc3a7db82dabbb9b88)이다.

- [NTP식 시계 측정](https://github.com/freeman-jiang/beatsync/blob/94c38ab16ec861835ce0b4bc3a7db82dabbb9b88/apps/client/src/utils/ntp.ts): 클라이언트 송신 `t0`, 서버 수신 `t1`, 서버 송신 `t2`, 클라이언트 수신 `t3`를 이용해 서버-클라이언트 시계 오프셋과 왕복 지연을 추정한다. 여러 측정 중 RTT가 가장 작은 표본을 신뢰한다.
- [미래 시각의 예약 명령](https://github.com/freeman-jiang/beatsync/blob/94c38ab16ec861835ce0b4bc3a7db82dabbb9b88/apps/server/src/websocket/handlers/pause.ts): 서버는 즉시 재생하라고 방송하지 않고 모든 클라이언트가 준비할 수 있는 미래의 `serverTimeToExecute`를 보낸다.
- [Web Audio 예약 재생](https://github.com/freeman-jiang/beatsync/blob/94c38ab16ec861835ce0b4bc3a7db82dabbb9b88/apps/client/src/store/global.tsx): 파일을 `AudioBuffer`로 디코딩하고 `AudioBufferSourceNode.start(when, offset)`과 `stop(when)`을 사용해 오디오 스레드의 시계에 예약한다.
- [시계 도메인 변환](https://github.com/freeman-jiang/beatsync/blob/94c38ab16ec861835ce0b4bc3a7db82dabbb9b88/apps/client/src/lib/audioContextManager.ts): `AudioContext.getOutputTimestamp()`로 `performance.now()`와 `AudioContext.currentTime`을 연결한다.
- 단일 `AudioContext`, iOS의 `suspended`/`interrupted` 복구, 미세한 무음 신호로 출력 경로를 warm 상태로 유지하는 패턴도 참고했다.

BeatSync는 Bun·Next.js·WebSocket 방 구조, coded probe pair, 동적 RTT 버퍼, 수동 nudge, 공간 음향까지 포함한다. 이 앱은 기존 Vanilla JS·Node·Supabase 구조를 유지하며 공동 연습에 필요한 최소 계층만 구현했다. BeatSync 코드를 복사해 의존성으로 포함한 것은 아니다.

## 4. 이 프로젝트에 적용한 해결 구조

### 음원과 영상을 분리

기존 파트별 MP4가 화면과 소리를 함께 담당하던 구조를 다음처럼 분리했다.

- `public/media/video/navigator-score.mp4`: 모든 파트가 공유하는 무음 악보 영상
- `public/media/audio/*.mp3`: 파트별 소리 전용
- `public/tracks.json`: 모든 파트의 같은 `videoFile`, 서로 다른 `audioFile`, 같은 `durationSec`

두 모드 모두 MP4 영상을 음소거하고 실제 소리는 MP3에서 낸다. 혼자 연습은 브라우저 `<audio>`로 MP3를 재생하고, 공동 연습은 미리 디코딩된 MP3 `AudioBuffer`를 사용한다. 파트 변경 시 영상 소스를 교체하지 않으므로 검은 화면과 중복 영상 다운로드를 피하면서, 공동 재생에서는 Web Audio의 정밀 예약을 유지한다.

### 서버 시계 보정

로컬 Node 서버는 `/api/time`, 운영 환경은 Supabase `choir_clock`을 사용한다. 클라이언트는 요청 전후 시각으로 RTT와 서버 오프셋을 계산하고 가장 RTT가 작은 표본을 선택한다. 참여할 때 다시 측정하고, 참여 중에는 60초마다 갱신한다.

### 재생과 정지를 모두 1.5초 뒤로 예약

서버 transport에는 다음 값이 포함된다.

- `positionSec`: 예약 시점의 곡 위치
- `startAtMs`: 공통 재생 시각
- `stopAtMs`: 공통 정지 시각
- `revision`: 명령 버전

재생뿐 아니라 정지도 `현재 서버 시각 + 1500ms`로 예약한다. 네트워크가 빠른 기기와 느린 기기 모두 명령을 받은 뒤 같은 목표 시각을 기다린다. 재생 중 seek도 새 미래 시각으로 다시 예약한다. 초기에는 보수적으로 3초를 사용했지만, MP3 사전 디코딩과 실기기 확인 뒤 반응성을 높이기 위해 1.5초로 줄였다.

### 서버 시각을 오디오 하드웨어 시각으로 변환

`public/shared-audio.js`는 다음 순서로 목표 시각을 변환한다.

```text
server epoch time
  → measured clock offset를 뺀 local epoch time
  → performance.now() clock
  → AudioContext.getOutputTimestamp()로 audio context time
  → AudioBufferSourceNode.start/stop 예약
```

`getOutputTimestamp()`를 제공하지 않는 브라우저에서는 `currentTime`과 `performance.now()` 차이를 이용한 fallback을 사용한다. 이 fallback은 출력 하드웨어 정보를 덜 제공하므로 진단 화면에서 별도로 확인해야 한다.

### iPhone과 출력 경로 안정화

- 사용자가 `연습 참여`를 누른 동작 안에서 `AudioContext.resume()`과 짧은 무음 버퍼 재생을 수행해 모바일 자동재생 제한을 해제한다.
- 가능한 경우 `navigator.audioSession.type = "playback"`을 설정한다.
- 1Hz, `-80dB`의 들리지 않는 keepalive 신호로 오디오 출력 경로가 pause 사이에 완전히 식지 않도록 한다.
- 화면 잠금·앱 전환 뒤 `visibilitychange`와 `online` 이벤트에서 시계를 다시 측정하고 중단된 AudioContext를 복구한다. 자동 복구가 거부되면 사용자가 다시 `연습 참여`를 누르도록 한다.

### 영상은 소리를 따라가는 표시 계층

공동 연습의 기준은 `<video>`가 아니라 Web Audio의 audible position이다. 영상은 음소거 상태로 서버 기준 위치를 따라가며 0.3초 이상 벌어질 때만 seek한다. 영상 보정이 실제 음원에 끊김을 만들지 않는다.

## 5. 진단 방법

주소에 `?syncDebug=1`을 붙이면 다음 값이 표시된다.

- 서버 기준 곡 위치
- 이 기기의 Web Audio 위치
- 두 위치의 차이
- AudioContext 상태
- 브라우저가 제공하는 `baseLatency`와 `outputLatency`
- 마지막 미디어 이벤트, transport revision, 서버 시계 보정값

화면 값만으로 최종 품질을 판정하지 않는다. 두 기기의 스피커음을 동시에 녹음하거나 사람이 같은 공간에서 직접 들어 실제 출력 시점을 함께 확인한다.

## 6. 검증 결과와 남은 한계

- 자동 테스트에서 서버 시각 변환, 성능 시각-오디오 시각 변환, 1.5초 재생·정지 예약, 권한과 상태 전파를 검증했다.
- Vite 프로덕션 빌드를 통과했다.
- Vercel `dev` Preview에서 컴퓨터와 iPhone의 내장 스피커를 사용했을 때 체감 가능한 시작 레이턴시가 없음을 확인했다.
- Bluetooth 무선 이어폰 조합은 아직 실기기 검증 전이다. Web Audio 예약과 keepalive로 변동 요인을 줄였지만, 이어폰 자체 DSP·A2DP 버퍼를 웹에서 완전히 통제할 수 있다고 보장하지 않는다.
- 현재 1.5초 준비 시간은 실기기 반응성과 명령 전달 여유를 절충한 고정값이다. 참여자가 많아지거나 네트워크 품질 차이가 커지면 BeatSync처럼 최대 RTT를 반영한 동적 예약 시간으로 발전시킬 수 있다.

## 7. 운영 중 다시 어긋날 때 확인 순서

1. 두 기기 모두 같은 파트이며 `연습 참여` 상태인지 확인한다.
2. `?syncDebug=1`에서 시계 보정값과 AudioContext 상태를 확인한다.
3. 새로고침 후 다시 참여해 오디오 사용자 제스처를 갱신한다.
4. 화면 잠금·전화·Siri·Bluetooth 출력 전환 직후라면 `연습 나가기` 후 다시 참여한다.
5. 특정 출력 장치에서만 반복되면 내장 스피커 결과와 분리해 기록한다.
6. `tracks.json`의 모든 파트 `durationSec`와 실제 MP3 시작 지점이 같은지 확인한다. 원본 음원의 앞부분 무음이 다르면 소프트웨어 동기화가 정확해도 소리는 어긋난다.
7. 운영 Supabase transport에 `stopAtMs`가 없다면 [`supabase/three-second-countdown.sql`](supabase/three-second-countdown.sql)을 다시 적용한다.

