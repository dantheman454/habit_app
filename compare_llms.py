#!/usr/bin/env python3
import sys, json, argparse, time
from urllib.request import Request, urlopen
from urllib.error import URLError

def chat(host, model, messages):
    payload = {"model": model, "messages": messages, "stream": False}
    req = Request(f"{host}/api/chat",
                  data=json.dumps(payload).encode("utf-8"),
                  headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=300) as r:
        data = json.load(r)
        return (data.get("message") or {}).get("content", "").strip()

def main():
    ap = argparse.ArgumentParser(
        description="Compare thinking vs non-thinking for both granite3.3:8b and granite-code:8b on the same questions."
    )
    ap.add_argument("questions", nargs="*", help="Question(s). If none, read newline-separated questions from stdin.")
    ap.add_argument(
        "-m",
        "--model",
        default="granite3.3:8b",
        help="Preferred display order start (granite3.3:8b or granite-code:8b). Default: granite3.3:8b",
    )
    ap.add_argument("--host", default="http://localhost:11434", help="Ollama host (default: http://localhost:11434)")
    ap.add_argument("-s", "--system", default=None, help="Optional system prompt.")
    args = ap.parse_args()

    if args.questions:
        questions = args.questions
    else:
        if sys.stdin.isatty():
            ap.error("Provide questions as arguments or pipe them via stdin.")
        questions = [line.strip() for line in sys.stdin if line.strip()]

    # We'll always compare these two models side-by-side
    primary_model = "granite3.3:8b"
    code_model = "granite-code:8b"
    if args.model == code_model:
        models = [code_model, primary_model]
    else:
        models = [primary_model, code_model]

    # Aggregates per model
    stats = {
        m: {
            "total_nonthinking_seconds": 0.0,
            "total_thinking_seconds": 0.0,
            "total_nonthinking_chars": 0,
            "total_thinking_chars": 0,
            "faster_nonthinking_count": 0,
            "faster_thinking_count": 0,
            "tie_count": 0,
            "identical_output_count": 0,
        }
        for m in models
    }

    for q in questions:
        base = []
        if args.system:
            base.append({"role": "system", "content": args.system})

        print(f"Q: {q}")
        for model in models:
            # Non-thinking
            t0 = time.perf_counter()
            non_thinking = chat(args.host, model, base + [{"role": "user", "content": q}])
            nonthinking_seconds = time.perf_counter() - t0

            # Thinking
            t1 = time.perf_counter()
            thinking = chat(
                args.host,
                model,
                base
                + [
                    {"role": "control", "content": "thinking"},
                    {"role": "user", "content": q},
                ],
            )
            thinking_seconds = time.perf_counter() - t1

            print(f"\nModel: {model}")
            print(f"-- non-thinking -- ({nonthinking_seconds:.2f}s, {len(non_thinking)} chars)")
            print(non_thinking)
            print(f"\n-- thinking -- ({thinking_seconds:.2f}s, {len(thinking)} chars)")
            print(thinking)

            # Update aggregates for this model
            mstats = stats[model]
            mstats["total_nonthinking_seconds"] += nonthinking_seconds
            mstats["total_thinking_seconds"] += thinking_seconds
            mstats["total_nonthinking_chars"] += len(non_thinking)
            mstats["total_thinking_chars"] += len(thinking)
            if nonthinking_seconds < thinking_seconds:
                mstats["faster_nonthinking_count"] += 1
            elif thinking_seconds < nonthinking_seconds:
                mstats["faster_thinking_count"] += 1
            else:
                mstats["tie_count"] += 1
            if non_thinking == thinking:
                mstats["identical_output_count"] += 1

        print("\n" + "=" * 60 + "\n")

    # Final summary per model
    n = len(questions)
    if n > 0:
        print("Summary")
        print("-" * 60)
        print(f"Questions: {n}")
        for model in models:
            mstats = stats[model]
            avg_nonthinking_seconds = mstats["total_nonthinking_seconds"] / n
            avg_thinking_seconds = mstats["total_thinking_seconds"] / n
            avg_nonthinking_chars = mstats["total_nonthinking_chars"] / n
            avg_thinking_chars = mstats["total_thinking_chars"] / n

            print(f"\nModel: {model}")
            print(
                f"Average latency: non-thinking {avg_nonthinking_seconds:.2f}s, thinking {avg_thinking_seconds:.2f}s"
            )
            print(
                f"Average length:  non-thinking {avg_nonthinking_chars:.0f} chars, thinking {avg_thinking_chars:.0f} chars"
            )
            print(
                f"Faster responses: non-thinking {mstats['faster_nonthinking_count']}, "
                f"thinking {mstats['faster_thinking_count']}, ties {mstats['tie_count']}"
            )
            print(f"Identical outputs: {mstats['identical_output_count']} / {n}")

if __name__ == "__main__":
    try:
        main()
    except URLError as e:
        sys.exit(f"Error calling Ollama: {e}")
