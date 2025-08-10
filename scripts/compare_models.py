#!/usr/bin/env python3
# Minimal CLI to run Function Calling evaluations and render HTML report

import argparse
import os
import signal
import subprocess
import sys
from datetime import datetime

from typing import List, Dict, Any

# Local imports (robust): ensure project root is on sys.path and support both package and direct module import
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TESTS_DIR = os.path.join(PROJECT_ROOT, "tests")
for p in (PROJECT_ROOT, TESTS_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

run_comprehensive_test = None
generate_results = None
MODELS = []
TEST_SCENARIOS = {}

try:
    # Prefer package-style import if 'tests' is a package
    from tests.test_models_tool_calling import run_comprehensive_test, generate_results, MODELS, TEST_SCENARIOS  # type: ignore
except Exception:
    try:
        # Fallback: import module directly from tests directory on sys.path
        from test_models_tool_calling import run_comprehensive_test, generate_results, MODELS, TEST_SCENARIOS  # type: ignore
    except Exception:
        # Leave fallbacks as None/empty; CLI will render minimal report
        pass


def start_mcp_server() -> subprocess.Popen:
    """Deprecated: tests spawn per-test servers via the Node client; no global server needed."""
    return None


def stop_process(proc: subprocess.Popen):
    if proc and proc.poll() is None:
        try:
            proc.send_signal(signal.SIGTERM)
        except Exception:
            pass


def render_html_report(summary_md: str, out_html: str):
    # Very small inline renderer using a simple template to avoid complex deps
    try:
        from jinja2 import Template
    except Exception:
        # Fallback: write raw preformatted HTML
        html = f"""
<!doctype html>
<html><head><meta charset='utf-8'><title>Model Comparison Report</title>
<style>body{{font-family:system-ui, sans-serif; margin:24px}} pre{{white-space:pre-wrap; background:#f6f8fa; padding:12px; border-radius:8px}} table{{border-collapse:collapse}} td,th{{border:1px solid #ddd;padding:6px 8px}}</style>
</head><body>
<h1>Model Comparison Report</h1>
<p>Template engine unavailable. Run the evaluation to generate JSON aggregates for the full report.</p>
</body></html>
"""
        with open(out_html, "w") as f:
            f.write(html)
        return

    template_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "results", "templates", "report.html.j2"))
    aggregates_path_latest = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "results", "summary_latest.json"))
    aggregates = None
    if os.path.exists(aggregates_path_latest):
        try:
            with open(aggregates_path_latest, "r") as jf:
                import json as _json
                aggregates = _json.load(jf)
        except Exception:
            aggregates = None

    if os.path.exists(template_path):
        with open(template_path, "r") as f:
            tmpl = Template(f.read())
        html = tmpl.render(aggregates=aggregates)
    else:
        tmpl = Template("""
<!doctype html>
<html><head><meta charset='utf-8'><title>Model Comparison Report</title>
<style>body{font-family:system-ui, sans-serif; margin:24px} pre{white-space:pre-wrap; background:#f6f8fa; padding:12px; border-radius:8px} table{border-collapse:collapse} td,th{border:1px solid #ddd;padding:6px 8px}</style>
</head><body>
<h1>Model Comparison Report</h1>
{% if aggregates %}
<h2>Overview</h2>
<div>Models: {{ aggregates.models | join(', ') }}</div>
{% else %}
<p>No aggregates available. Run the evaluation to generate results.</p>
{% endif %}
</body></html>
""")
        html = tmpl.render(aggregates=aggregates)

    with open(out_html, "w") as f:
        f.write(html)


def main():
    parser = argparse.ArgumentParser(description="Compare local Ollama models (Function Calling only)")
    parser.add_argument("--models", nargs="*", default=MODELS or [], help="Models to test (default: from tests)")
    # Step-specific model flags (backward compatible; current harness uses a single set)
    parser.add_argument(
        "--models-extract",
        nargs="*",
        default=[],
        help="Models to use for Extract step (pipeline mode). Note: currently combined with other step flags as a union until per-step execution is supported."
    )
    parser.add_argument(
        "--models-verify",
        nargs="*",
        default=[],
        help="Models to use for Verify step (pipeline mode). Note: currently combined with other step flags as a union until per-step execution is supported."
    )
    parser.add_argument(
        "--models-execute",
        nargs="*",
        default=[],
        help="Models to use for Execute step (pipeline mode). Note: currently combined with other step flags as a union until per-step execution is supported."
    )
    parser.add_argument("--discover", action="store_true", help="Discover models via 'ollama list'")
    parser.add_argument("--scenarios", default="", help="Comma-separated scenario names to run (default: all)")
    parser.add_argument("--out", default="results", help="Output directory (default: results)")
    parser.add_argument("--max-parallel-models", type=int, default=1, help="Parallelize across models (default: 1)")
    # New: auto-open report flag (default true; disable with --open-report=false)
    parser.add_argument("--open-report", type=lambda v: str(v).lower() != "false", default=True, help="Open the generated HTML report (default: true on macOS)")
    # New: phase selection
    parser.add_argument("--phase", choices=["all", "extraction", "verification", "execution"], default=os.getenv("EVAL_PHASE", "all"), help="Select EVX phase to run (default: all)")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)

    server_proc = start_mcp_server()
    try:
        # Run comprehensive tests via imported test runner if available
        if run_comprehensive_test is not None and generate_results is not None:
            # Apply CLI overrides
            try:
                import tests.test_models_tool_calling as tm
            except Exception:
                try:
                    import test_models_tool_calling as tm
                except Exception:
                    tm = None
            if tm is not None:

                # Discover models if requested
                if args.discover:
                    try:
                        proc = subprocess.run(["ollama", "list"], capture_output=True, text=True, check=False)
                        discovered = []
                        if proc.returncode == 0:
                            for line in proc.stdout.splitlines():
                                parts = line.strip().split()
                                if parts:
                                    discovered.append(parts[0])
                        if discovered:
                            tm.MODELS[:] = discovered
                    except Exception:
                        pass

                # Override models from CLI if provided
                if args.models:
                    tm.MODELS[:] = list(args.models)
                else:
                    # Auto-discover when --models omitted
                    try:
                        proc = subprocess.run(["ollama", "list"], capture_output=True, text=True, check=False)
                        discovered = []
                        if proc.returncode == 0:
                            for line in proc.stdout.splitlines():
                                parts = line.strip().split()
                                if parts:
                                    discovered.append(parts[0])
                        if discovered:
                            tm.MODELS[:] = discovered
                    except Exception:
                        pass

                # Backward-compatible handling of step-specific flags:
                # 1) Union behavior still defines the overall MODELS list
                # 2) Additionally set step-specific lists in the harness if available
                step_specific = set()
                for sub in (args.models_extract or []):
                    step_specific.add(sub)
                for sub in (args.models_verify or []):
                    step_specific.add(sub)
                for sub in (args.models_execute or []):
                    step_specific.add(sub)
                if step_specific:
                    tm.MODELS[:] = sorted(step_specific)
                # Propagate step lists to harness if those attributes exist
                if hasattr(tm, "MODELS_EXTRACT"):
                    tm.MODELS_EXTRACT[:] = list(args.models_extract or [])
                if hasattr(tm, "MODELS_VERIFY"):
                    tm.MODELS_VERIFY[:] = list(args.models_verify or [])
                if hasattr(tm, "MODELS_EXECUTE"):
                    tm.MODELS_EXECUTE[:] = list(args.models_execute or [])

                # Filter scenarios if provided
                if args.scenarios:
                    wanted = {s.strip() for s in args.scenarios.split(',') if s.strip()}
                    tm.TEST_SCENARIOS = {k: v for k, v in tm.TEST_SCENARIOS.items() if k in wanted}

                # Propagate phase to harness if available
                try:
                    tm.PHASE = args.phase
                except Exception:
                    pass
            

            # The runner internally writes summary and detailed logs
            # Pass parallelism through if supported
            try:
                run_comprehensive_test(max_parallel_models=args.max_parallel_models)
            except TypeError:
                run_comprehensive_test()
            # Read summary to embed into HTML
            summary_md_path = os.path.join(os.path.dirname(__file__), "..", "results", "TEST_RESULTS_SUMMARY.md")
            with open(summary_md_path, "r") as f:
                summary_md = f.read()
        else:
            # Fallback minimal summary
            summary_md = "# Results\n\nTest runner unavailable in this environment."

        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        out_html = os.path.abspath(os.path.join(args.out, f"report_{timestamp}.html"))
        render_html_report(summary_md, out_html)
        print(f"HTML report written to: {out_html}")

        # Write/update stable pointer to latest report
        try:
            import shutil
            latest_html = os.path.abspath(os.path.join(args.out, "report_latest.html"))
            shutil.copyfile(out_html, latest_html)
        except Exception:
            pass

        # Auto-open report on macOS if enabled
        if args.open_report:
            try:
                if sys.platform == "darwin":
                    subprocess.run(["open", out_html], check=False)
            except Exception:
                pass
    finally:
        stop_process(server_proc)


if __name__ == "__main__":
    main()


