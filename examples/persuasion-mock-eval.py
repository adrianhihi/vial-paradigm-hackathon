"""
Mock local evaluator for Paradigm's Persuasion challenge.

Official scoring: median price across 15 diverse AI buyers.
This mock: median price across 5 Haiku-played personas (5x cheaper for rehearsal).

Usage:
    python eval.py path/to/candidate.txt

Output (matched by adapter's parseScore):
    Median price: 42.50
"""
import sys
import os
import re
import statistics
from anthropic import Anthropic

MODEL = "claude-haiku-4-5-20251001"
MAX_CHARS = 140

PERSONAS = [
    {
        "name": "Budget Student",
        "system": "You are a frugal college student with $200/month discretionary income. You only buy what you absolutely need. You are skeptical of marketing and look for practical value. Respond ONLY with a single USD number (no currency symbol, no explanation). If you would not buy it at all, say 0.",
    },
    {
        "name": "Wealthy Collector",
        "system": "You are a wealthy art collector who appreciates craftsmanship and rare design. Money is not a concern. You value aesthetic beauty, heritage, and exclusivity. Respond ONLY with a single USD number (no currency symbol, no explanation).",
    },
    {
        "name": "Pragmatic Engineer",
        "system": "You are a pragmatic software engineer. You evaluate purchases on function per dollar. You like durable, well-designed tools but distrust puffery and status signaling. Respond ONLY with a single USD number (no currency symbol, no explanation).",
    },
    {
        "name": "Minimalist Designer",
        "system": "You are a minimalist industrial designer. You value restraint, material quality, and understated elegance. You pay well for beautiful essentials but refuse ornament. Respond ONLY with a single USD number (no currency symbol, no explanation).",
    },
    {
        "name": "Tech Gadget Enthusiast",
        "system": "You are an early-adopter tech enthusiast who loves novel gadgets. You pay a premium for innovation, clever features, and the latest trends. Respond ONLY with a single USD number (no currency symbol, no explanation).",
    },
]

PRICE_REGEX = re.compile(r"\$?\s*(\d{1,6}(?:\.\d{1,2})?)")


def ask_persona(client: Anthropic, persona: dict, description: str) -> float:
    """Returns the price this persona would pay, or 0.0 on parse failure."""
    try:
        res = client.messages.create(
            model=MODEL,
            max_tokens=30,
            system=persona["system"],
            messages=[
                {
                    "role": "user",
                    "content": f'How much USD would you pay for this pen?\n\nDescription: "{description}"\n\nRespond with only a single number.',
                }
            ],
        )
        text = "".join(b.text for b in res.content if getattr(b, "type", None) == "text").strip()
        m = PRICE_REGEX.search(text)
        if not m:
            print(f"  [{persona['name']}] unparseable: {text!r}", file=sys.stderr)
            return 0.0
        return float(m.group(1))
    except Exception as e:
        print(f"  [{persona['name']}] API error: {e}", file=sys.stderr)
        return 0.0


def main():
    if len(sys.argv) != 2:
        print("usage: python eval.py <candidate.txt>", file=sys.stderr)
        sys.exit(2)

    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"ValidationError: file not found: {path}", file=sys.stderr)
        sys.exit(1)

    with open(path) as f:
        description = f.read().strip()

    print(f"Validating candidate: {path}")
    print(f"Description ({len(description)} chars): {description!r}")

    # Character limit enforcement — mirror official 140 char rule
    if len(description) == 0:
        print("ValidationError: empty description", file=sys.stderr)
        sys.exit(1)
    if len(description) > MAX_CHARS:
        print(
            f"ValidationError: description is {len(description)} chars, max is {MAX_CHARS}",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Running {len(PERSONAS)} persona judgments...")
    client = Anthropic()
    prices = []
    for persona in PERSONAS:
        price = ask_persona(client, persona, description)
        print(f"  {persona['name']}: ${price:.2f}")
        prices.append(price)

    median = statistics.median(prices)
    mean = statistics.mean(prices)
    print()
    print(f"Prices: {prices}")
    print(f"Mean price: {mean:.2f}")
    print(f"Median price: {median:.2f}")


if __name__ == "__main__":
    main()
