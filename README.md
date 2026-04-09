# Vial × Paradigm Automated Research Hackathon

**April 9, 2026 — Paradigm HQ, SF**
Adrian (online, Vancouver) · Nicholas (in-person, SF)

## Strategy recap

- **Project Track** (Nicholas, in-person): Demo Vial's PCEC loop as an automated-research harness on Paradigm's own Simple AMM benchmark. A/B: naive LLM loop vs. Vial-wrapped LLM loop. Live dashboard showing Gene Map growing in real time.
- **Challenge Track** (Adrian, online): Reuse the same meta-loop harness to attack whichever of the 3 new leaderboards drops at 8 AM PT. Language-agnostic because the adapter decouples challenge-specific bits from the runtime.
- **Feedback loop between the two tracks**: Adrian's live Challenge Track run is simultaneously the data source for Nicholas's live Project Track dashboard. "My co-founder is running this right now in Vancouver" is the closing line.

## What's in this repo

```
paradigm-hack/
├── adapter/                          # @vial-agent/adapter-optimization-arena
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── types.ts                  # Translation layer: arena → runtime
│       ├── gene-map.ts               # SQLite Gene Map + iteration log
│       ├── runner.ts                 # Main meta-loop (baseline / vial / ab)
│       └── challenges/
│           └── simple-amm.ts         # Challenge def + 8 seed capsules
├── dashboard/
│   ├── index.html                    # Live dashboard (polls JSON every 1.5s)
│   └── dashboard-state.json          # Sample data for offline preview
└── pitch/
    └── onepager.html                 # Printable one-page pitch for Nicholas
```

## Grep discipline — brand and domain purity

- All arena-specific terminology (Solidity, Edge, fee, normalizer, bps) lives **only** inside `adapter/src/challenges/` and nowhere else.
- `adapter/src/types.ts`, `gene-map.ts`, `runner.ts` are generic: they speak "challenge", "candidate", "score", "failure signal", "capsule". This is the same discipline as `@vial-agent/runtime` staying 100% domain-agnostic while `@helix-agent/core` owns payment vocabulary.
- Before shipping, run: `grep -rE "nonce|gas|AMM|fee|Solidity" adapter/src/types.ts adapter/src/gene-map.ts adapter/src/runner.ts` — **should return zero matches**. (`runner.ts` imports the challenge object but never references its contents by name.)

## Runbook — tonight

### Confirmed facts about the Simple AMM challenge (verified from ammchallenge.com / benedictbrady repo)

- **Submission**: single `.sol` file, contract named `Strategy`, inherits `AMMStrategyBase`
- **Required methods** (all must have `external override`):
  - `afterInitialize(uint256 initialX, uint256 initialY) → (uint256 bidFee, uint256 askFee)`
  - `afterSwap(TradeInfo calldata trade) → (uint256 bidFee, uint256 askFee)`
  - `getName() external pure → string memory`
- **Two-dimensional fee**: `bidFee` (sell side) and `askFee` (buy side) are independent. Asymmetric strategies are allowed and underexploited.
- **TradeInfo**: `isBuy, amountX, amountY, timestamp, reserveX, reserveY` (all WAD precision where applicable)
- **Storage**: 32 slots, `slots[0..31]`
- **Helpers**: `wmul, wdiv, sqrt, clampFee, bpsToWad, WAD, BPS`
- **Max fee**: 10% (`bpsToWad(1000)`)
- **Simulation**: 10,000 steps × 1000 sims (default) or pass `--simulations N` for faster dev
- **Price process**: GBM with σ ~ U[0.088%, 0.101%] per step
- **Retail**: Poisson(λ ~ U[0.6, 1.0]) orders/step, LogNormal sizes, 50/50 buy/sell
- **Competitor**: fixed 30 bps normalizer AMM, both start at (100 X, 10_000 Y) @ price 100
- **Score**: Edge = retail profit - arb losses, averaged over sims
- **Normalizer's own score**: typically **250-350** — this is our reference floor

### Critical pitfalls to avoid

1. **Do NOT return a single value from afterSwap**. It returns **two** values (bidFee, askFee). The starter returns one by mistake is NOT the starter — the starter returns two. Your LLM prompts must make this explicit.
2. **Do NOT forget `getName()`**. It's required, easy to miss. Compile failure if absent.
3. **Do NOT hardcode fees above ~35 bps**. Above the normalizer, retail routes away and edge collapses to ~0.
4. **Do NOT confuse WAD and BPS**. Use `bpsToWad(30)` for 30 bps. Raw `30` in fee slots will be interpreted as near-zero fee.

### Phase 1: Environment setup

**T-0 to T+30min: Clone and sanity-check the official challenge repo**
```bash
# Clone the official Paradigm repo (confirmed via ammchallenge.com):
git clone https://github.com/benedictbrady/amm-challenge.git ./amm-challenge
cd amm-challenge

# Build the Rust simulation engine (requires Rust + maturin)
cd amm_sim_rs
pip install maturin
maturin develop --release
cd ..

# Install the Python CLI
pip install -e .

# Sanity check with the starter strategy
amm-match validate contracts/src/StarterStrategy.sol
amm-match run contracts/src/StarterStrategy.sol --simulations 10
# Expected: average edge printed; starter is 50 bps fixed → should score BELOW 250
# (i.e. worse than the 30 bps normalizer — this is expected and proves the harness works)
```

**T+30 to T+60: Verify `simple-amm.ts` matches reality**
- `starterPath: "contracts/src/StarterStrategy.sol"` ✅ already correct
- `evaluatorCommand` uses `amm-match run` ✅ already correct
- **Verify `parseScore` regex against real stdout** — run `amm-match run StarterStrategy.sol --simulations 10 2>&1 | tee /tmp/starter.out`, open `/tmp/starter.out`, confirm the regex `/average\s+edge[:\s]+(-?[\d.]+)/i` matches. If the actual format is different (e.g. "Edge (avg): 287.4"), add a new pattern to the `patterns` array.
- **Verify `baselineScoreReference: 250`** — if the starter's own score is in the 100-200 range (it should be, since 50 bps is above normalizer), the 250 floor correctly marks it as "below reference" and the PCEC loop will fire.

**T+60 to T+90: Wire `@vial-agent/runtime` properly (optional for demo)**
- Current `gene-map.ts` is a standalone SQLite mirror. For the demo this is fine — the A/B comparison is the proof, not which package the code lives in.
- If you want the "real Vial runtime" story on Nicholas's slide, add `import { Runtime } from "@vial-agent/runtime"` and route PCEC through it. This is ~1 hour of work and not blocking for the demo.

**T+90 to T+120: Dry run full pipeline**
```bash
# Ensure ANTHROPIC_API_KEY is in env
export ANTHROPIC_API_KEY=sk-...

# Run a short A/B for dry-run verification
cd adapter
npm run build
node dist/runner.js --mode ab --iterations 5 --challenge-repo ../../amm-challenge \
  --dashboard ../dashboard/dashboard-state.json

# In another terminal:
cd dashboard && python3 -m http.server 8080
# Open http://localhost:8080 — verify live updates
```

**T+120 to T+150: Canned deterministic replay for Nicholas**
- Save the successful dry run's `dashboard-state.json` as `dashboard/canned-state.json`
- Add a URL query param support in `index.html`: `?state=./canned-state.json` already works via the `STATE_PATH` line
- Nicholas can demo with `?state=./canned-state.json` if the live one flakes
- **Demo stability risk**: from your memory file, you've been burned before. Canned replay is the safety net.

**T+150 to T+180: Pitch polish**
- Open `pitch/onepager.html` in browser, print to PDF, send to Nicholas
- Nicholas prints 5 physical copies to hand out
- The `id="m-baseline"` etc. fields in the HTML are placeholders — once you have dry run numbers, replace them with real numbers (or leave as "— (live)" and quote them verbally on stage)

## Runbook — tomorrow morning (Adrian, Vancouver)

**8:00 AM PT: New leaderboards drop**
- Refresh optimizationarena.com; the 3 new challenges will be listed
- For each new challenge, decide in **5 minutes** which one is most tractable for the meta-loop approach
  - **Best fits**: anything with a local evaluator, text-based submission, and a clear score
  - **Worst fits**: ONNX model uploads (requires training infra we don't have today)
- Create a new `adapter/src/challenges/<slug>.ts` by cloning `simple-amm.ts`
- Fill in: prompt, systemContext, starterPath, evaluatorCommand, parseScore
- 10-minute smoke test with `--mode baseline --iterations 2`
- Then launch `--mode ab --iterations 30` and let it run until 3:30 PM PT
- Submit best candidate to leaderboard at 3:45 PM PT (15 min before 4 PM freeze)

**Simultaneously**: the dashboard-state.json from the Challenge Track run becomes Nicholas's live demo data. Coordinate with him:
- Share dashboard URL (ngrok tunnel from `python3 -m http.server` works for ephemeral sharing)
- Post key milestones in the shared Slack/TG: "iter 15, baseline=X, vial=Y, +Z%"

**4:00 PM PT: Leaderboard freeze. Project Track presentations 4–5:30 PM PT**
- Nicholas presents with dashboard pulled up on projector
- The story: "Vial is our runtime. We built it for payments (here's the Base A/B proof). Today we pointed it at an automated research loop on Paradigm's own AMM challenge. Same mechanism, new domain. And my co-founder in Vancouver is running it live on today's Challenge Track right now — here's the dashboard."

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Official repo has different CLI than our guess | 30-min buffer to reconcile `simple-amm.ts` tonight |
| Forge/Anvil not installed on challenge repo clone | Install foundry tonight, test the harness before writing any LLM code |
| LLM token budget blowup | Hard-capped at `max_tokens: 4000`; 30 iterations × 2 modes = ~60 calls ≈ $2-5 |
| Live dashboard flakes during Nicholas's demo | Canned `canned-state.json` replay as fallback |
| Baseline actually beats Vial (embarrassing) | Seeded capsules are strong enough that this is unlikely, but if it happens: re-frame as "both converged, Gene Map is the moat for the next run" and pivot to the Base A/B numbers |
| Paradigm people ask hard technical questions | Nicholas references the helix-project-context-apr2.md + dev-roadmap-apr4.md context; for anything deep he says "Adrian is on Signal right now, one sec" |
| No time to run 30 iterations tonight in dry run | 5 iterations is enough to verify plumbing; tomorrow morning is the real run |

## What this is NOT

- Not a fine-tuning run. No model weights are updated.
- Not a new LLM. We use Sonnet 4.5 as the base generator in both arms.
- Not a claim to beat human Solidity experts. The Challenge Track leaderboard has humans at the top. **Our claim is about the *gap between naive LLM and Vial-wrapped LLM*, not about absolute ranking.** This framing is important.
- Not Helix. This is **Vial** — the domain-agnostic runtime underneath Helix. If anyone asks "is this payments?", the answer is "payments was our first vertical (Helix), this is Vial applied to a different vertical."

## Contact (for Nicholas on stage)

- GitHub: `github.com/adrianhihi/helix`
- npm: `@vial-agent/runtime`, `@helix-agent/core`, `n8n-nodes-vialos`
- Base proof report: `helix-base-ab-test-report.html` (keep on laptop, 144 txs on-chain)
- Architecture deck: `helix-architecture.html`
