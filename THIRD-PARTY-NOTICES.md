# 서드파티 고지

이 앱은 Apache-2.0 이지만, 설치 파일에는 다른 라이선스의 구성 요소가 함께 들어 있습니다.
각 구성 요소는 **자신의 라이선스**를 따릅니다 — Apache-2.0 이 이들에 적용되지 않습니다.

## 설치 파일에 동봉되는 것

| 구성 요소 | 라이선스 | 용도 |
|---|---|---|
| [Electron](https://github.com/electron/electron) | MIT | 앱 런타임 |
| [CPython](https://www.python.org/) (python-build-standalone) | PSF-2.0 | 동봉 엔진 인터프리터 |
| [geny-executor](https://github.com/CocoRoF/geny-executor) 및 의존성 | 각 패키지 라이선스 | 에이전트 엔진 |
| [Babylon.js](https://github.com/BabylonJS/Babylon.js) | Apache-2.0 | MMD 아바타 렌더링 |
| [babylon-mmd](https://github.com/noname0310/babylon-mmd) | MIT | PMX 로더 · MMD 런타임 |
| [pixi.js](https://github.com/pixijs/pixijs) 6.x | MIT | Live2D 아바타 렌더링 |
| [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | MIT | Live2D 모델 표시 |

## 동봉되지 **않는** 것 — 사용자가 직접 가져오는 것

### Live2D Cubism Core

`live2dcubismcore.min.js` 는 설치 파일에 들어 있지 **않습니다**. 앱의 [설정 → 아바타] →
[Cubism Core 받기] 가 [Live2D 공식 배포처](https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js)
에서 **사용자의 모델 폴더로 직접** 내려받습니다. 이 프로젝트는 이 파일을 재배포하지 않습니다.

파일 자체는 Live2D 가 "Redistributable Code" 로 지정했고, 독점 소프트웨어 사용권 계약
§5.1 은 응용 프로그램의 일부로 배포하는 것을 허용합니다. 동봉하지 않는 이유는 그것과 별개인
**SDK 배포 라이선스(Publication License Agreement)** 때문입니다:

> The SDK Release License (Publication License Agreement) does not apply to works that
> include Expandable Applications such as avatar systems.
> … A separate contract is also required for each work, regardless of whether the user is
> a General User, Small-Scale Enterprise, or Large Entity.
> — <https://help.live2d.com/en/sdk/sdk_001/>

개인·소규모(연 매출 1,000만 엔 미만) 면제는 일반적인 응용 프로그램에 적용되며,
**"Expandable Application"(아바타 시스템)은 그 면제에서 제외**되어 규모와 무관하게 건별 계약이
필요합니다. 이 앱은 사용자가 모델을 무제한으로 넣는 아바타 시스템이므로 정확히 그 범주입니다.

**혼자 쓰는 것은 여기에 해당하지 않습니다** — 자기 PC 에서 자기 모델을 보는 것은 자유롭게 할 수
있고, 앱은 그 경로를 한 번의 클릭으로 만들어 둡니다. 제약은 *배포*에 붙습니다.

- Live2D 독점 소프트웨어 사용권 계약: <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- SDK 배포 라이선스 안내: <https://www.live2d.com/en/sdk/license/>

### Spine 런타임

`spine-player.js` · `spine-player.css` 는 Esoteric Software 의 Spine 라이선스가 필요해
동봉하지 않습니다. 모델 폴더의 `runtime/` 에 직접 넣으면 앱이 표시합니다.

### 아바타 모델

`<데이터 폴더>/avatars/` 에 넣는 모델은 사용자 소유이며 각 모델의 이용 약관을 따릅니다.
앱은 어떤 모델도 동봉하지 않습니다.

---

이 문서는 법률 자문이 아닙니다. 만든 것을 배포할 계획이라면 각 라이선스를 직접 확인하세요.
