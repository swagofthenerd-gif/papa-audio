# All 310 roadmap items — progress tracker

Updated 2026-09-15. A001–A160 map to 001–160 in the music roadmap. V001–V150 map to the video roadmap. Full requirements and acceptance criteria remain in the two original files. No item is claimed complete on simulated DOM tests alone.

Completed implementation batches, tests, limitations and recovery status are recorded in HANDOFF.md. 11 video items partially addressed (this tracker), plus 3 music items fixed and 1 already satisfied (docs/ux/STATUS.md, merged 2026-09-15 from a parallel session). Full-suite result after the merge: 4402 pass / 0 fail on Node ≥ 22.23.

| Item | Status |
| --- | --- |
| A001 | Fixed `58e0b7e` — wizard is an offer, not a gate; see STATUS.md |
| A002 | Fixed — permanent Settings nav entry, openSettings(section); see STATUS.md |
| A003 | Pending review/implementation |
| A004 | Fixed `55143ea` — Clear upcoming / Stop and clear; see STATUS.md |
| A005 | Fixed — vertical wheel scrolls the page; rows get arrows; see STATUS.md |
| A006 | Pending review/implementation |
| A007 | Pending review/implementation |
| A008 | Fixed `9d801e0` — OS-aware install instructions; see STATUS.md |
| A009 | Pending review/implementation |
| A010 | Pending review/implementation |
| A011 | Pending review/implementation |
| A012 | Already satisfied on this branch — local @font-face; see STATUS.md |
| A013 | Partial — one-sentence product description on wizard step 1 (with A001) |
| A014 | Pending review/implementation |
| A015 | Pending review/implementation |
| A016 | Pending review/implementation |
| A017 | Fixed — wizard states read-in-place and that sharing is a separate setting (with A137) |
| A018 | Pending review/implementation |
| A019 | Fixed `94eec8a` |
| A020 | Pending review/implementation |
| A021 | Fixed `2d47c50` |
| A022 | Pending review/implementation |
| A023 | Pending review/implementation |
| A024 | Pending review/implementation |
| A025 | Pending review/implementation |
| A026 | Pending review/implementation |
| A027 | Pending review/implementation |
| A028 | Pending review/implementation |
| A029 | Pending review/implementation |
| A030 | Pending review/implementation |
| A031 | Pending review/implementation |
| A032 | Pending review/implementation |
| A033 | Pending review/implementation |
| A034 | Fixed `4f045cd` — refused/silent Play reported |
| A035 | Pending review/implementation |
| A036 | Pending review/implementation |
| A037 | Fixed `54d84c0` — sleep keeps the place |
| A038 | Fixed `273a9d8` — device loss pauses by default |
| A039 | Pending review/implementation |
| A040 | Fixed — prevAction rule + help text |
| A041 | Fixed `b4c4997` |
| A042 | Pending review/implementation |
| A043 | Pending review/implementation |
| A044 | Fixed — time left · total |
| A045 | Fixed — insertPlayNext single rule |
| A046 | Pending review/implementation |
| A047 | Fixed — next pick shown; original order kept |
| A048 | Fixed `6ba664c` — Locate/Remove for missing queue files |
| A049 | Fixed `e8d95f1` |
| A050 | Fixed `8a69303` |
| A051 | Fixed `92584be` — Keep both offered |
| A052 | Pending review/implementation |
| A053 | Pending review/implementation |
| A054 | Pending review/implementation |
| A055 | Pending review/implementation |
| A056 | Pending review/implementation |
| A057 | Fixed `890a469` — source-failure classifier |
| A058 | Pending review/implementation |
| A059 | Pending review/implementation |
| A060 | Pending review/implementation |
| A061 | Pending review/implementation |
| A062 | Pending review/implementation |
| A063 | Pending review/implementation |
| A064 | Pending review/implementation |
| A065 | Pending review/implementation |
| A066 | Pending review/implementation |
| A067 | Pending review/implementation |
| A068 | Pending review/implementation |
| A069 | Pending review/implementation |
| A070 | Pending review/implementation |
| A071 | Pending review/implementation |
| A072 | Pending review/implementation |
| A073 | Pending review/implementation |
| A074 | Pending review/implementation |
| A075 | Pending review/implementation |
| A076 | Already satisfied — scheduler caps distinct sources per file (maxAttempts 4), attempts shown per row, cancel stops it |
| A077 | Pending review/implementation |
| A078 | Pending review/implementation |
| A079 | Fixed `bfb2d44` — capacity check before enqueue |
| A080 | Fixed — outcomes stated on every action |
| A081 | Fixed — one notice per album, click to play |
| A082 | Pending review/implementation |
| A083 | Fixed `71abddb` — relink carries every store and the cache |
| A084 | Fixed `2e01d08` — unplugged root = unavailable, not deleted |
| A085 | Fixed `71abddb` — guided relink with preview |
| A086 | Pending review/implementation |
| A087 | Fixed — hero edits write real tags with an explicit scope note; see STATUS.md |
| A088 | Pending review/implementation |
| A089 | Pending review/implementation |
| A090 | Pending review/implementation |
| A091 | Fixed `3668f0b` — move journal + startup recovery |
| A092 | Pending review/implementation |
| A093 | Fixed `1da705b` — codec-checked LOSSLESS, full-chain BIT-PERFECT; see STATUS.md |
| A094 | Pending review/implementation |
| A095 | Pending review/implementation |
| A096 | Fixed `578f3e5` — gain policy + clipping risk |
| A097 | Pending review/implementation |
| A098 | Fixed `5a988f3` |
| A099 | Pending review/implementation |
| A100 | Pending review/implementation |
| A101 | Pending review/implementation |
| A102 | Pending review/implementation |
| A103 | Pending review/implementation |
| A104 | Pending review/implementation |
| A105 | Pending review/implementation |
| A106 | Fixed `037e34b` — Stop aborts + honest |
| A107 | Pending review/implementation |
| A108 | Pending review/implementation |
| A109 | Pending review/implementation |
| A110 | Fixed `ece3972` — disclosure + cloud scrubbing |
| A111 | Pending review/implementation |
| A112 | Pending review/implementation |
| A113 | Pending review/implementation |
| A114 | Fixed `157ddc1` — ARIA sliders + keys |
| A115 | Pending review/implementation |
| A116 | Partial — toasts/snackbars are polite live regions, track changes announced once, seek value throttled; screen-reader pass pending |
| A117 | Pending review/implementation |
| A118 | Pending review/implementation |
| A119 | Pending review/implementation |
| A120 | Pending review/implementation |
| A121 | Fixed `f1f37c3` |
| A122 | Pending review/implementation |
| A123 | Pending review/implementation |
| A124 | Pending review/implementation |
| A125 | Pending review/implementation |
| A126 | Pending review/implementation |
| A127 | Pending review/implementation |
| A128 | Fixed — tooltip, hover pause, reduced-motion ellipsis |
| A129 | Pending review/implementation |
| A130 | Fixed `36366fc` |
| A131 | Pending review/implementation |
| A132 | Pending review/implementation |
| A133 | Pending review/implementation |
| A134 | Deferred — needs the app running (see STATUS.md) |
| A135 | Pending review/implementation |
| A136 | Fixed `20689d5` — redact at write and export |
| A137 | Fixed `54971c2` — sharing is a stated setting |
| A138 | Pending review/implementation |
| A139 | Fixed `ef3789a` — pre-update backup + RECOVERY.md |
| A140 | Pending review/implementation |
| A141 | Pending review/implementation |
| A142 | Pending review/implementation |
| A143 | Pending review/implementation |
| A144 | Pending review/implementation |
| A145 | Pending review/implementation |
| A146 | Pending review/implementation |
| A147 | Pending review/implementation |
| A148 | Pending review/implementation |
| A149 | Pending review/implementation |
| A150 | Pending review/implementation |
| A151 | Pending review/implementation |
| A152 | Pending review/implementation |
| A153 | Pending review/implementation |
| A154 | Pending review/implementation |
| A155 | Pending review/implementation |
| A156 | Pending review/implementation |
| A157 | Pending review/implementation |
| A158 | Pending review/implementation |
| A159 | Pending review/implementation |
| A160 | Pending review/implementation |
| V001 | Pending review/implementation |
| V002 | Pending review/implementation |
| V003 | Pending review/implementation |
| V004 | Pending review/implementation |
| V005 | Pending review/implementation |
| V006 | Pending review/implementation |
| V007 | Pending review/implementation |
| V008 | Pending review/implementation |
| V009 | Pending review/implementation |
| V010 | Pending review/implementation |
| V011 | Pending review/implementation |
| V012 | Fixed `3d58e3b` — Play / Resume from <time> / Start over |
| V013 | Pending review/implementation |
| V014 | Pending review/implementation |
| V015 | Pending review/implementation |
| V016 | Pending review/implementation |
| V017 | Pending review/implementation |
| V018 | Pending review/implementation |
| V019 | Pending review/implementation |
| V020 | Pending review/implementation |
| V021 | Pending review/implementation |
| V022 | Pending review/implementation |
| V023 | Pending review/implementation |
| V024 | Pending review/implementation |
| V025 | Pending review/implementation |
| V026 | Pending review/implementation |
| V027 | Partial — source fix and targeted tests; desktop verification pending |
| V028 | Pending review/implementation |
| V029 | Pending review/implementation |
| V030 | Pending review/implementation |
| V031 | Pending review/implementation |
| V032 | Partial (structural) — one _videoState drives request, title, watch key and next target; season tickets guard late metadata (V033); runtime check pending |
| V033 | Pending review/implementation |
| V034 | Fixed `90c2816` |
| V035 | Pending review/implementation |
| V036 | Partial — source fix and targeted tests; desktop verification pending |
| V037 | Fixed `e1e9fc4` |
| V038 | Already satisfied — episode-list.js labels future dates "Airs …" in local time, rows carry `unaired`, Play is withheld |
| V039 | Pending review/implementation |
| V040 | Pending review/implementation |
| V041 | Fixed `58293d6` |
| V042 | Fixed `58293d6` |
| V043 | Pending review/implementation |
| V044 | Pending review/implementation |
| V045 | Fixed `2037c8d` — edition-aware skip |
| V046 | Pending review/implementation |
| V047 | Pending review/implementation |
| V048 | Pending review/implementation |
| V049 | Pending review/implementation |
| V050 | Pending review/implementation |
| V051 | Pending review/implementation |
| V052 | Fixed `726414d` — inferred vs measured badges |
| V053 | Pending review/implementation |
| V054 | Pending review/implementation |
| V055 | Fixed `012c192` — pack pick verdict |
| V056 | Pending review/implementation |
| V057 | Partial — single in-flight auto-switch guard and session epochs exist (other session); runtime check pending |
| V058 | Pending review/implementation |
| V059 | Pending review/implementation |
| V060 | Partial — detail/season tickets and current() guards cover discovery/probing/opening; runtime check pending |
| V061 | Already satisfied in source — Finding sources / Still connecting / Buffering N% / Downloading N% · Mbps · peers / stuck words / error; runtime check pending |
| V062 | Pending review/implementation |
| V063 | Pending review/implementation |
| V064 | Pending review/implementation |
| V065 | Pending review/implementation |
| V066 | Pending review/implementation |
| V067 | Pending review/implementation |
| V068 | Pending review/implementation |
| V069 | Pending review/implementation |
| V070 | Pending review/implementation |
| V071 | Pending review/implementation |
| V072 | Pending review/implementation |
| V073 | Partial — source fix and targeted tests; desktop verification pending |
| V074 | Partial — source fix and targeted tests; desktop verification pending |
| V075 | Pending review/implementation |
| V076 | Partial — source fix and targeted tests; desktop verification pending |
| V077 | Pending review/implementation |
| V078 | Pending review/implementation |
| V079 | Pending review/implementation |
| V080 | Partial — source fix and targeted tests; desktop verification pending |
| V081 | Pending review/implementation |
| V082 | Fixed `356f05c` |
| V083 | Pending review/implementation |
| V084 | Pending review/implementation |
| V085 | Pending review/implementation |
| V086 | Pending review/implementation |
| V087 | Pending review/implementation |
| V088 | Fixed `5428081` |
| V089 | Pending review/implementation |
| V090 | Pending review/implementation |
| V091 | Pending review/implementation |
| V092 | Pending review/implementation |
| V093 | Pending review/implementation |
| V094 | Pending review/implementation |
| V095 | Pending review/implementation |
| V096 | Pending review/implementation |
| V097 | Fixed `bf9c785` — Stop and close vs Back; Esc never stops |
| V098 | Pending review/implementation |
| V099 | Pending review/implementation |
| V100 | Pending review/implementation |
| V101 | Partial — source fix and targeted tests; desktop verification pending |
| V102 | Partial — source fix and targeted tests; desktop verification pending |
| V103 | Partial — source fix and targeted tests; desktop verification pending |
| V104 | Partial — source fix and targeted tests; desktop verification pending |
| V105 | Partial — source fix and targeted tests; desktop verification pending |
| V106 | Pending review/implementation |
| V107 | Pending review/implementation |
| V108 | Pending review/implementation |
| V109 | Fixed `9ef44c1` — media keys to the active session |
| V110 | Pending review/implementation |
| V111 | Fixed — 5 % start threshold capped at 120 s; see STATUS.md |
| V112 | Pending review/implementation |
| V113 | Fixed `7e5dd3a` — pause checkpoint; close/pagehide flush |
| V114 | Pending review/implementation |
| V115 | Pending review/implementation |
| V116 | Already satisfied — watch keys are type:id:season:episode, never source-specific (`_watchKey`) |
| V117 | Pending review/implementation |
| V118 | Pending review/implementation |
| V119 | Not applicable — there is no external watch sync (AniList is a catalog only); revisit if one is added |
| V120 | Pending review/implementation |
| V121 | Fixed `0a86fd5` |
| V122 | Pending review/implementation |
| V123 | Fixed `f429e67` |
| V124 | Pending review/implementation |
| V125 | Fixed `212b659` |
| V126 | Pending review/implementation |
| V127 | Pending review/implementation |
| V128 | Pending review/implementation |
| V129 | Fixed `0e60fd1` |
| V130 | Fixed via A136 — bundles scrubbed of tokens/paths (`20689d5`) |
| V131 | Pending review/implementation |
| V132 | Fixed `87ce8d7` |
| V133 | Pending review/implementation |
| V134 | Pending review/implementation |
| V135 | Pending review/implementation |
| V136 | Pending review/implementation |
| V137 | Pending review/implementation |
| V138 | Pending review/implementation |
| V139 | Pending review/implementation |
| V140 | Pending review/implementation |
| V141 | Pending review/implementation |
| V142 | Pending review/implementation |
| V143 | Pending review/implementation |
| V144 | Pending review/implementation |
| V145 | Pending review/implementation |
| V146 | Pending review/implementation |
| V147 | Pending review/implementation |
| V148 | Pending review/implementation |
| V149 | Pending review/implementation |
| V150 | Pending review/implementation |
