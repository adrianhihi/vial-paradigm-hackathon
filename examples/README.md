# Examples — Templates for tomorrow

## persuasion-mock-eval.py

A template for building your own local evaluator when a Paradigm challenge
does NOT ship an official local harness (e.g. Persuasion). Uses cheap LLM
judges (Haiku 4.5) to simulate the buyer personas locally.

### Copy pattern for a new LLM-judged challenge

1. Copy this file to `~/Projects/<new-challenge>/eval.py`
2. Edit the `PERSONAS` list with the new challenge's judge criteria
3. Edit the user prompt template in `ask_persona()`
4. Verify the output line matches your `challenges/<new>.ts` parseScore regex
   (this template prints `Median price: N.NN`)
5. Test manually: `python eval.py sample.txt`
6. Register in `adapter/src/runner.ts` CHALLENGE_REGISTRY

### Used for

- Persuasion challenge rehearsal on 2026-04-08 (validated full end-to-end
  workflow: new challenge repo → new challenge.ts → registry → smoke test)
