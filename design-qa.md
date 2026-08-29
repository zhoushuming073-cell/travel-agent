# Design QA — 用户画像模板还原与全局流程导航

## Scope

- Visual source: `C:\Users\周树铭\.codex\skills\artifact-template-ai\assets\reference.png` (1600×1024).
- Supplied motion asset: `C:\Users\周树铭\Desktop\Face scanning.json`.
- Implementation route: `/travel/trip-4b69aa5b-b74`.
- Browser used: the in-app browser selected for this project.

## Visual comparison evidence

| Artifact | Path |
| --- | --- |
| Reference copy | `C:\Users\周树铭\Desktop\smart_travel_assistant_live_port8090\sites-app\.design-qa\reference.png` |
| Rendered implementation | `C:\Users\周树铭\Desktop\smart_travel_assistant_live_port8090\sites-app\.design-qa\implementation.png` |
| Combined comparison input | `C:\Users\周树铭\Desktop\smart_travel_assistant_live_port8090\sites-app\.design-qa\comparison.png` |

The implementation was exercised at the available 1280×720 browser viewport. The reference is 1600×1024; the combined comparison preserves each capture's aspect ratio. Runtime layout measurements confirmed `scrollWidth 1265 <= innerWidth 1280`, so the rendered page has no horizontal overflow even though the in-app screenshot preview crops its right edge.

## Findings and fixes

| Severity | Finding | Fix | Verification |
| --- | --- | --- | --- |
| P1 | The earlier central media did not match the selected asset and introduced a React runtime conflict. | Replaced it with the supplied Bodymovin JSON through the direct `lottie-web` player and isolated lifecycle cleanup. | One live SVG renderer is present; two captures 700 ms apart differ, confirming animation playback; no runtime error overlay. |
| P2 | User-profile composition diverged from the reference. | Matched the reference's expanded dark sidebar, compact top process line, centered title, left facts, central scan, right inference/constraints, and bottom completion rail. | Inspected in the combined comparison input. |
| P2 | The right information column was too narrow and the three-column grid overflowed with an expanded sidebar. | Rebalanced desktop columns and added a 1450 px responsive layout for the real content width. | Expanded sidebar width is 252 px; page scroll width remains inside the viewport. |
| P2 | The Chinese sidebar brand name inherited a dark body color and disappeared. | Added an explicit high-contrast sidebar brand style. | Chinese and English brand names are both visible in the final capture. |
| P2 | The four-step navigation occupied too much top space and was changed only on the profile screen. | Applied the same 740 px compact process navigation globally, retaining active, completed, and review states. | All four review stages report the same 740 px progress width and four functional step controls. |

## Interaction and regression checks

- Stage navigation: `理解需求 / 信息搜集 / 智能规划 / 方案呈现` all remain clickable in completed-trip review.
- Profile action: `检查旅行参数` opens the existing editable parameter panel.
- Reduced motion: animation pauses at a representative frame when the operating system requests reduced motion.
- Type checking: passed.
- Linting: passed.
- Domain tests: 58/58 passed.
- Production build: passed. The bundler reports the standard third-party `lottie-web` expression-player warning, with no build failure.

## Compact single-screen iteration

- Source capture: `.design-qa/reference.png`.
- Before capture: `.design-qa/compact-before.png`.
- Final capture: `.design-qa/compact-after.png`.
- Combined visual review: `.design-qa/compact-comparison.png`.
- At the tested 1280×720 desktop viewport, `scrollHeight` now equals `innerHeight` (720 px), so the complete profile workspace is visible without vertical scrolling.
- The compact rules only apply to desktop windows at or below 820 px height; taller screens retain the roomier reference proportions.
- The supplied Lottie animation, six profile tags, all left/right information groups, progress state, and completion action remain visible.

final result: passed
