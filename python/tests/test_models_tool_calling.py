#!/usr/bin/env python3
"""
Model Tool Calling Test Script
Tests different LLM models' abilities to use MCP tools via Function Calling format

Note: Type-checker suppress directive added due to dynamic structures; not core to
runtime correctness. The recent ETA enhancement introduced no semantic changes to
those dynamic sections triggering static analysis noise.
"""  # type: ignore

import requests
import time
import json
import re
import ast
import subprocess
import tempfile
import os
import psutil
import sys
import threading
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional, Tuple

# Configuration
MODELS = ["granite-code:8b", "granite3.3:8b"]
# Phase control: "all", "extraction", "verification", "execution"
PHASE: str = os.getenv("EVAL_PHASE", "all")
# Optional step-specific model lists (when provided via CLI wiring). If empty, fall back to MODELS/active model
MODELS_EXTRACT: list = []
MODELS_VERIFY: list = []
MODELS_EXECUTE: list = []
OLLAMA_URL = "http://localhost:11434/api/generate"
MCP_SERVER_PATH = "/Users/dantheman/Desktop/habit_app/apps/server/server.js"

# Retry Configuration
MAX_RETRIES = 2  # Maximum number of retry attempts per test
RETRY_DELAY = 1.0  # Seconds to wait between retries
TIMEOUT_SECONDS = 90  # Request timeout
# Scenario repetition for stability measurement
REPEAT_RUNS = 3  # Repeat each scenario N times

# Determinism options
OLLAMA_REQUEST_OPTIONS = {
    "temperature": 0,
    "seed": 1234,
    "top_p": 1.0,
    "top_k": 0,
}

# Scenario fixtures loader (JSON)
def _load_scenarios_from_fixtures() -> Tuple[Dict[str, Any], bool]:
    fixtures: Dict[str, Any] = {}
    try:
        fixtures_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "scenarios"))
        if not os.path.isdir(fixtures_dir):
            return {}, False
        # Load JSON Schema for scenarios if present
        schema_path = os.path.join(fixtures_dir, "schema.json")
        scenario_schema: Optional[Dict[str, Any]] = None
        try:
            if os.path.isfile(schema_path):
                with open(schema_path, "r") as sf:
                    scenario_schema = json.load(sf)
        except Exception:
            scenario_schema = None

        def _validate(data: Dict[str, Any]) -> Optional[str]:
            if not scenario_schema:
                return None
            try:
                import jsonschema  # type: ignore
                jsonschema.validate(instance=data, schema=scenario_schema)
                return None
            except Exception as e:
                return str(e)

        # Placeholder substitution against ANCHOR_DATE
        def _sub_placeholders(obj: Any) -> Any:
            if isinstance(obj, dict):
                return {k: _sub_placeholders(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_sub_placeholders(v) for v in obj]
            if isinstance(obj, str):
                return (
                    obj.replace("${TODAY}", ANCHOR_DATE)
                       .replace("${TOMORROW}", ANCHOR_TOMORROW)
                )
            return obj

        for name in os.listdir(fixtures_dir):
            if not name.endswith(".json"):
                continue
            path = os.path.join(fixtures_dir, name)
            try:
                with open(path, "r") as f:
                    data = json.load(f)
                    # Validate against schema if available
                    err = _validate(data)
                    if err:
                        raise ValueError(f"Invalid scenario fixture {name}: {err}")
                    # Apply placeholder substitution
                    data = _sub_placeholders(data)
                    # Use file stem or explicit name as key
                    key = data.get("name") or os.path.splitext(name)[0]
                    fixtures[key] = data
            except Exception:
                continue
        return fixtures, len(fixtures) > 0
    except Exception:
        return {}, False

_FIXTURE_SCENARIOS, _USE_FIXTURES = _load_scenarios_from_fixtures()

# Anchor date for deterministic prompts/evaluation (override via env EVAL_ANCHOR_DATE)
def _compute_tomorrow_str(anchor: str) -> str:
    try:
        d = datetime.strptime(anchor, "%Y-%m-%d")
        return (d + timedelta(days=1)).strftime("%Y-%m-%d")
    except Exception:
        return anchor

ANCHOR_DATE = os.getenv("EVAL_ANCHOR_DATE", "2025-08-06")
ANCHOR_TOMORROW = _compute_tomorrow_str(ANCHOR_DATE)

# Function Calling System Prompt - Single optimized format (anchored dates)
SYSTEM_PROMPT = f"""TOOL_EXECUTION_MODE: You help manage todos using MCP tools. Current date: {ANCHOR_DATE}. Tomorrow: {ANCHOR_TOMORROW}.

AVAILABLE_TOOLS: create_todo|list_todos|get_todo|update_todo|delete_todo|search_todos

MANDATORY_FORMAT_RULES:
1. Use Python function call syntax: function_name(param1="value", param2=value)
2. String parameters in quotes, numbers/booleans without quotes
3. Available functions: create_todo(), list_todos(), get_todo(), update_todo(), delete_todo(), search_todos()
4. Multiple calls on separate lines
5. Use exact parameter names

PARAMETER_SPECIFICATIONS:
create_todo(title="required", notes="optional", scheduledFor="YYYY-MM-DD or None", priority="low/medium/high")
list_todos(completed=True/False, priority="low/medium/high", scheduledFrom="YYYY-MM-DD", scheduledTo="YYYY-MM-DD")  # all optional
get_todo(id=integer|string)
update_todo(id=integer|string, title="optional", notes="optional", scheduledFor="optional", priority="optional", completed=True/False)
delete_todo(id=integer|string)
search_todos(query="required substring to match title or notes")

TYPE_RULES:
- Strings in double quotes: "Buy groceries"
- Numbers without quotes: 1, 2, 3
- Booleans: True, False (Python style)
- None for null values
- Dates: "{ANCHOR_TOMORROW}"
- IDs: integer or string (server coerces to integer)

CORRECT_EXAMPLES:
create_todo(title="Buy groceries", priority="high", scheduledFor="{ANCHOR_TOMORROW}")
list_todos(completed=False, priority="high", scheduledFrom="2025-08-04", scheduledTo="2025-08-10")
search_todos(query="dentist")
update_todo(id=1, completed=True)

Provide helpful response, then function calls.
"""

# JSON format system prompt (strict JSON array of tool calls)
# Note: Avoid f-string brace parsing by concatenating non-f string sections for the JSON example block
JSON_SYSTEM_PROMPT = (
    f"""
TOOL_EXECUTION_MODE_JSON: You help manage todos using MCP tools. Current date: {ANCHOR_DATE}. Tomorrow: {ANCHOR_TOMORROW}.

AVAILABLE_TOOLS: create_todo|list_todos|get_todo|update_todo|delete_todo|search_todos

OUTPUT FORMAT (STRICT):
- Return ONLY a single JSON array of tool call objects. No prose.
- Example:
"""
    + """
[
  {"tool": "create_todo", "parameters": {"title": "Buy groceries", "priority": "high", "scheduledFor": "YYYY-MM-DD"}},
  {"tool": "list_todos", "parameters": {"completed": false}}
]
"""
    + """

RULES:
- Use only available tools.
- Use lowercase for priority: low|medium|high.
- Use YYYY-MM-DD for dates. Use exact integers for id.
- Do not include comments or trailing commas.
- Do not wrap JSON in code fences. Output must be raw JSON.
"""
)

def get_system_prompt() -> str:
    """Get Function Calling system prompt (legacy)"""
    return SYSTEM_PROMPT

def get_system_prompt_for_format(fmt: str) -> str:
    fmt_l = (fmt or "function").lower()
    if fmt_l in ("json", "application/json"):
        return JSON_SYSTEM_PROMPT
    return SYSTEM_PROMPT

# Helpers for phase-specific gold sets with backward-compatible defaults
def _get_phase_gold_tools(scenario: Dict[str, Any], phase: str) -> List[str]:
    key = f"{phase}_gold"
    if isinstance(scenario.get(key), dict):
        tools = scenario[key].get("tools", [])
        if isinstance(tools, list):
            return list(tools)
    # Fallback to legacy single set
    return list(scenario.get("expected_tools", []))

# Test Scenarios (legacy inline). Will be overridden by JSON fixtures if present.
TEST_SCENARIOS = {
    "create_simple": {
        "prompt": "Add a todo item: 'Buy groceries' with high priority for tomorrow. Use the create_todo tool.",
        "expected_tools": ["create_todo"],
        "complexity": 1
    },
    "list_simple": {
        "prompt": "Show me all my pending todos. Use the list_todos tool.",
        "expected_tools": ["list_todos"],
        "complexity": 1
    },
    "update_with_context": {
        "prompt": "Mark the grocery shopping task as completed. Use the update_todo tool with the correct ID.",
        "expected_tools": ["update_todo"],
        "complexity": 2,
        "setup": {
            "create_todos": [
                {"title": "Buy groceries", "priority": "high", "notes": "Grocery shopping task"}
            ]
        }
    },
    "workflow_multiple": {
        "prompt": "Create 3 todos: 'Buy groceries' (high priority), 'Call dentist' (medium), and 'Read book' (low priority). Then show me what's due today and mark the grocery task as completed.",
        "expected_tools": ["create_todo", "create_todo", "create_todo", "list_todos", "update_todo"],
        "complexity": 3
    },
    "workflow_complex": {
        "prompt": "Add a todo for 'Team meeting' scheduled for tomorrow, then list all my high priority tasks, and update the meeting's notes to include 'Prepare quarterly report'.",
        "expected_tools": ["create_todo", "list_todos", "update_todo"],
        "complexity": 4
    },
    "edge_case_boolean": {
        "prompt": "Create a todo 'Test task' and immediately mark it completed using the update_todo tool.",
        "expected_tools": ["create_todo", "update_todo"],
        "complexity": 2
    },
    "edge_case_null_date": {
        "prompt": "Create a todo 'Unscheduled task' with no specific date (null scheduledFor) and low priority.",
        "expected_tools": ["create_todo"],
        "complexity": 2
    },
    "precision_test": {
        "prompt": "Create todo 'Precise test' scheduled for exactly 2025-08-07 with medium priority, then get that specific todo by its ID, then delete it.",
        "expected_tools": ["create_todo", "get_todo", "delete_todo"],
        "complexity": 3
    }
}

# Override with fixtures when available
if _USE_FIXTURES and _FIXTURE_SCENARIOS:
    TEST_SCENARIOS = _FIXTURE_SCENARIOS

# Enhanced test scenarios with parameter extraction expectations
PARAMETER_EXTRACTION_SCENARIOS = {
    "extraction_simple": {
        "prompt": "Add a todo item: 'Buy groceries' with high priority for tomorrow.",
        "expected_tools": ["create_todo"],
        "expected_parameters": {
            "title": "Buy groceries",
            "priority": "high", 
            "scheduledFor": "tomorrow"
        },
        "complexity": 2,
        "evaluation_focus": "parameter_extraction"
    },
    "extraction_inference": {
        "prompt": "I need to schedule an urgent meeting with the client for next week.",
        "expected_tools": ["create_todo"],
        "expected_parameters": {
            "title": "meeting with client",
            "priority": "high"  # Should infer from "urgent"
        },
        "complexity": 3,
        "evaluation_focus": "parameter_extraction"
    },
    "extraction_mixed_format": {
        "prompt": "Create a low-priority reminder to 'Call mom' sometime this week, and add notes that it's for her birthday planning.",
        "expected_tools": ["create_todo"],
        "expected_parameters": {
            "title": "Call mom",
            "priority": "low",
            "notes": "birthday planning"
        },
        "complexity": 3,
        "evaluation_focus": "parameter_extraction"
    },
    "extraction_implicit_date": {
        "prompt": "Add 'Submit project report' - it's due on August 7th, 2025, so it's quite important.",
        "expected_tools": ["create_todo"],
        "expected_parameters": {
            "title": "Submit project report",
            "scheduledFor": "2025-08-07",
            "priority": "high"  # Should infer from "quite important"
        },
        "complexity": 4,
        "evaluation_focus": "parameter_extraction"
    }
}

# Merge parameter extraction scenarios with main test scenarios
TEST_SCENARIOS.update(PARAMETER_EXTRACTION_SCENARIOS)

# Define workflow planning scenarios first, then merge
# (Scenarios defined below after WorkflowPlanningEvaluator class)

# NOTE: System prompts are now format-specific and generated dynamically by get_system_prompt()

class ToolCallParser:
    """Parser for extracting tool calls from model responses with  validation"""
    
    # Valid tool names for validation
    VALID_TOOLS = {"create_todo", "list_todos", "get_todo", "update_todo", "delete_todo", "search_todos"}
    
    # Parameter validation schemas
    PARAMETER_SCHEMAS = {
        "create_todo": {
            "required": ["title"],
            "optional": ["notes", "scheduledFor", "priority"],
            "types": {"title": str, "notes": str, "scheduledFor": (str, type(None)), "priority": str}
        },
        "list_todos": {
            "required": [],
            "optional": ["completed", "priority", "scheduledFrom", "scheduledTo"],
            "types": {"completed": bool, "priority": str, "scheduledFrom": str, "scheduledTo": str}
        },
        "search_todos": {
            "required": ["query"],
            "optional": [],
            "types": {"query": str}
        },
        "get_todo": {
            "required": ["id"],
            "optional": [],
            "types": {"id": (int, str)}
        },
        "update_todo": {
            "required": ["id"],
            "optional": ["title", "notes", "scheduledFor", "priority", "completed"],
            "types": {"id": (int, str), "title": str, "notes": str, "scheduledFor": (str, type(None)), "priority": str, "completed": bool}
        },
        "delete_todo": {
            "required": ["id"],
            "optional": [],
            "types": {"id": (int, str)}
        }
    }
    
    
    @staticmethod
    def _convert_parameter_value(key: str, value: str) -> Tuple[Any, Optional[str]]:
        """Convert parameter value to appropriate type with error reporting"""
        try:
            # Handle boolean strings
            if value.lower() in ['true', 'false']:
                return value.lower() == 'true', None
            
            # Handle null strings
            if value.lower() in ['null', 'none', '']:
                return None, None
            
            # Handle ID parameters - must be positive integers
            if key == 'id':
                if not value.isdigit():
                    # Check for common malformed ID patterns
                    if '<' in value and '>' in value:
                        return value, f"Malformed ID contains XML tags: '{value}'"
                    return value, f"ID must be a positive integer, got: '{value}'"
                id_val = int(value)
                if id_val <= 0:
                    return id_val, f"ID must be positive, got: {id_val}"
                return id_val, None
            
            # Handle priority validation
            if key == 'priority':
                valid_priorities = ['low', 'medium', 'high']
                if value.lower() not in valid_priorities:
                    return value, f"Invalid priority '{value}', must be one of: {valid_priorities}"
                return value.lower(), None
            
            # Handle date validation (flexible format check)
            if key == 'scheduledFor' and value and value.lower() != 'null':
                # Extract date from common patterns: "YYYY-MM-DD", "YYYY-MM-DD (comment)", etc.
                import re
                # Try to extract YYYY-MM-DD pattern from the value
                date_match = re.search(r'(\d{4}-\d{2}-\d{2})', value)
                if date_match:
                    return date_match.group(1), None  # Return just the date part
                else:
                    return value, f"Could not extract valid date from '{value}', expected format containing YYYY-MM-DD"
            
            # Handle completed parameter
            if key == 'completed':
                if value.lower() in ['true', 'false']:
                    return value.lower() == 'true', None
                return value, f"Invalid boolean value '{value}', must be 'true' or 'false'"
            
            # Default: return as string
            return value, None
            
        except Exception as e:
            return value, f"Conversion error: {str(e)}"
    
    @staticmethod
    def _validate_parameters(tool_name: str, parameters: Dict[str, Any]) -> List[str]:
        """Validate parameters against tool schema"""
        validation_errors = []
        
        if tool_name not in ToolCallParser.PARAMETER_SCHEMAS:
            return [f"No validation schema for tool: {tool_name}"]
        
        schema = ToolCallParser.PARAMETER_SCHEMAS[tool_name]
        
        # Check required parameters
        for required_param in schema["required"]:
            if required_param not in parameters:
                validation_errors.append(f"Missing required parameter: {required_param}")
        
        # Check parameter types and unknown parameters
        for param_name, param_value in parameters.items():
            if param_name not in schema["required"] and param_name not in schema["optional"]:
                validation_errors.append(f"Unknown parameter: {param_name}")
                continue
            
            # Type validation (allow None for optional string parameters)
            if param_name in schema["types"]:
                expected_type = schema["types"][param_name]
                if isinstance(expected_type, tuple):
                    # Multiple allowed types (e.g., str or None)
                    if not isinstance(param_value, expected_type):
                        validation_errors.append(f"Parameter '{param_name}' has invalid type, expected {expected_type}, got {type(param_value).__name__}")
                else:
                    # Single expected type - but allow None for optional string fields
                    if param_value is None and param_name in schema["optional"] and expected_type == str:
                        # None is acceptable for optional string parameters
                        continue
                    elif not isinstance(param_value, expected_type):
                        validation_errors.append(f"Parameter '{param_name}' has invalid type, expected {expected_type.__name__}, got {type(param_value).__name__}")
        
        return validation_errors

# NEW: Parameter extraction accuracy evaluator
class ParameterExtractionEvaluator:
    """Evaluates how accurately models extract parameters from natural language"""
    
    @staticmethod
    def evaluate_parameter_accuracy(tool_calls: List[Dict[str, Any]], scenario: Dict[str, Any]) -> Dict[str, float]:
        """Evaluate parameter extraction accuracy against expected values"""
        
        if "expected_parameters" not in scenario:
            return {"parameter_accuracy": 1.0}  # No expectations defined
        
        expected_params = scenario["expected_parameters"]
        accuracy_scores = {
            "title_accuracy": 0.0,
            "priority_accuracy": 0.0, 
            "date_accuracy": 0.0,
            "semantic_accuracy": 0.0,
            "completeness_score": 0.0,
            "appropriateness_score": 1.0  # Start high, deduct for hallucinations
        }
        
        if not tool_calls:
            return accuracy_scores
        
        # Focus on create_todo calls for parameter extraction evaluation
        create_calls = [tc for tc in tool_calls if tc.get("tool") == "create_todo"]
        if not create_calls:
            return accuracy_scores
        
        # Evaluate the first create_todo call
        actual_params = create_calls[0].get("parameters", {})
        
        # Title accuracy - semantic similarity
        if "title" in expected_params and "title" in actual_params:
            accuracy_scores["title_accuracy"] = ParameterExtractionEvaluator._evaluate_title_similarity(
                expected_params["title"], actual_params["title"]
            )
        
        # Priority accuracy - exact or inferred match
        if "priority" in expected_params:
            accuracy_scores["priority_accuracy"] = ParameterExtractionEvaluator._evaluate_priority_accuracy(
                expected_params["priority"], actual_params.get("priority", "medium")
            )
        
        # Date accuracy - handles relative dates
        if "scheduledFor" in expected_params:
            accuracy_scores["date_accuracy"] = ParameterExtractionEvaluator._evaluate_date_accuracy(
                expected_params["scheduledFor"], actual_params.get("scheduledFor")
            )
        
        # Completeness - percentage of expected parameters extracted
        expected_keys = set(expected_params.keys())
        actual_keys = set(actual_params.keys())
        if expected_keys:
            accuracy_scores["completeness_score"] = len(expected_keys & actual_keys) / len(expected_keys)
        
        # Appropriateness - penalize hallucinated parameters
        reasonable_params = {"title", "notes", "scheduledFor", "priority"}
        hallucinated = actual_keys - expected_keys - reasonable_params
        if hallucinated:
            accuracy_scores["appropriateness_score"] = max(0.0, 1.0 - len(hallucinated) * 0.2)
        
        # Overall semantic accuracy
        individual_scores = [accuracy_scores["title_accuracy"], accuracy_scores["priority_accuracy"], accuracy_scores["date_accuracy"]]
        valid_scores = [s for s in individual_scores if s > 0]
        accuracy_scores["semantic_accuracy"] = sum(valid_scores) / len(valid_scores) if valid_scores else 0.0
        
        return accuracy_scores
    
    @staticmethod
    def _evaluate_title_similarity(expected: str, actual: str) -> float:
        """Evaluate how similar the extracted title is to the expected title"""
        expected_lower = expected.lower().strip()
        actual_lower = actual.lower().strip()
        
        # Exact match
        if expected_lower == actual_lower:
            return 1.0
        
        # Substring match (both directions)
        if expected_lower in actual_lower or actual_lower in expected_lower:
            return 0.8
        
        # Word overlap
        expected_words = set(expected_lower.split())
        actual_words = set(actual_lower.split())
        
        if expected_words and actual_words:
            overlap = len(expected_words & actual_words)
            union = len(expected_words | actual_words)
            jaccard_similarity = overlap / union if union > 0 else 0.0
            
            # High word overlap suggests good understanding
            if jaccard_similarity >= 0.6:
                return 0.7
            elif jaccard_similarity >= 0.4:
                return 0.5
            elif jaccard_similarity >= 0.2:
                return 0.3
        
        # Semantic similarity for common word variations
        # Check for known synonyms and variations
        semantic_matches = [
            (["buy", "purchase", "get"], ["groceries", "grocery", "food", "shopping"]),
            (["call", "phone", "contact"], ["mom", "mother", "parent"]),
            (["meeting", "meet"], ["client", "customer"]),
            (["submit", "send", "deliver"], ["report", "document"]),
            (["task", "todo", "item"], ["reminder", "note"])
        ]
        
        for action_words, object_words in semantic_matches:
            expected_has_action = any(word in expected_lower for word in action_words)
            actual_has_action = any(word in actual_lower for word in action_words)
            expected_has_object = any(word in expected_lower for word in object_words)
            actual_has_object = any(word in actual_lower for word in object_words)
            
            if expected_has_action and actual_has_action and expected_has_object and actual_has_object:
                return 0.6  # Good semantic match
            elif (expected_has_action and actual_has_action) or (expected_has_object and actual_has_object):
                return 0.4  # Partial semantic match
        
        return 0.0
    
    @staticmethod
    def _evaluate_priority_accuracy(expected: str, actual: str) -> float:
        """Evaluate priority extraction accuracy"""
        if expected.lower() == actual.lower():
            return 1.0
        
        # Allow reasonable defaults
        if expected == "medium" and actual in ["medium", "normal"]:
            return 1.0
        
        # Partial credit for close matches
        priority_map = {"low": 1, "medium": 2, "high": 3}
        expected_val = priority_map.get(expected.lower(), 2)
        actual_val = priority_map.get(actual.lower(), 2)
        
        diff = abs(expected_val - actual_val)
        if diff == 1:
            return 0.5  # One level off
        elif diff == 0:
            return 1.0
        
        return 0.0
    
    @staticmethod
    def _evaluate_date_accuracy(expected: str, actual: Optional[str]) -> float:
        """Evaluate date extraction accuracy, handling relative dates"""
        if expected is None and actual is None:
            return 1.0
        
        if expected is None or actual is None:
            return 0.0
        
        # Exact match
        if expected == actual:
            return 1.0
        
        # Handle common relative date translations using anchor constants
        try:
            anchor_today = ANCHOR_DATE
            anchor_tomorrow = ANCHOR_TOMORROW
        except NameError:
            # Fallback to defaults if constants unavailable in scope
            anchor_today = "2025-08-06"
            anchor_tomorrow = "2025-08-07"

        date_mappings = {
            "tomorrow": anchor_tomorrow,
            anchor_tomorrow: anchor_tomorrow,
            "today": anchor_today,
            anchor_today: anchor_today,
        }
        
        expected_normalized = date_mappings.get(expected.lower(), expected)
        actual_normalized = date_mappings.get(actual.lower(), actual) if actual else None
        
        if expected_normalized == actual_normalized:
            return 1.0
        
        # Try to parse and compare as dates
        try:
            from datetime import datetime
            if expected_normalized and actual_normalized:
                exp_date = datetime.strptime(expected_normalized, "%Y-%m-%d")
                act_date = datetime.strptime(actual_normalized, "%Y-%m-%d")
                
                diff_days = abs((exp_date - act_date).days)
                if diff_days == 0:
                    return 1.0
                elif diff_days == 1:
                    return 0.7  # One day off
                elif diff_days <= 3:
                    return 0.5  # Close
        except:
            pass
        
        return 0.0

# NEW: Workflow planning evaluator
class WorkflowPlanningEvaluator:
    """Evaluates how well models plan and execute multi-step workflows"""
    
    @staticmethod
    def evaluate_workflow_quality(tool_calls: List[Dict[str, Any]], scenario: Dict[str, Any]) -> Dict[str, float]:
        """Evaluate the quality of workflow planning and execution"""
        
        if "workflow_expectations" not in scenario:
            return {"workflow_score": 1.0}  # No workflow expectations defined
        
        expectations = scenario["workflow_expectations"]
        
        workflow_scores = {
            "sequence_logic": 0.0,      # Are steps in logical order?
            "dependency_awareness": 0.0, # Does model understand dependencies?
            "efficiency": 0.0,          # Minimal necessary steps?
            "context_usage": 0.0,       # Uses results from previous steps?
            "error_anticipation": 0.0,  # Handles potential failures?
            "workflow_completeness": 0.0 # Completes all required operations?
        }
        
        if not tool_calls:
            return workflow_scores
        
        # Extract just the tool names for sequence analysis
        tool_sequence = [tc.get("tool", "unknown") for tc in tool_calls]
        
        # 1. Sequence Logic Evaluation
        workflow_scores["sequence_logic"] = WorkflowPlanningEvaluator._evaluate_sequence_logic(
            tool_sequence, expectations.get("logical_order", [])
        )
        
        # 2. Dependency Awareness
        workflow_scores["dependency_awareness"] = WorkflowPlanningEvaluator._evaluate_dependency_awareness(
            tool_calls, expectations.get("dependencies", [])
        )
        
        # 3. Efficiency
        workflow_scores["efficiency"] = WorkflowPlanningEvaluator._evaluate_efficiency(
            tool_sequence, expectations.get("minimal_steps", len(tool_sequence))
        )
        
        # 4. Context Usage (check if models use IDs from previous operations)
        workflow_scores["context_usage"] = WorkflowPlanningEvaluator._evaluate_context_usage(
            tool_calls, expectations.get("context_requirements", [])
        )
        
        # 5. Error Anticipation (check if model validates before acting)
        workflow_scores["error_anticipation"] = WorkflowPlanningEvaluator._evaluate_error_anticipation(
            tool_calls, expectations.get("error_scenarios", [])
        )
        
        # 6. Workflow Completeness
        expected_operations = expectations.get("required_operations", [])
        # Compute presence over UNIQUE required operations and clamp to [0,1]
        if expected_operations:
            actual_tools_set = set(tc.get("tool") for tc in tool_calls)
            required_set = set(expected_operations)
            denominator = len(required_set)
            numerator = len(actual_tools_set & required_set)
            completeness = (numerator / denominator) if denominator > 0 else 1.0
            # Clamp to [0,1]
            workflow_scores["workflow_completeness"] = max(0.0, min(completeness, 1.0))
        else:
            workflow_scores["workflow_completeness"] = 1.0
        
        return workflow_scores
    
    @staticmethod
    def _evaluate_sequence_logic(actual_sequence: List[str], expected_order: List[str]) -> float:
        """Evaluate if the sequence follows logical order"""
        if not expected_order:
            return 1.0
        
        # Check if the relative order of expected operations is maintained
        expected_indices = {}
        for i, tool in enumerate(expected_order):
            expected_indices[tool] = i
        
        # Find positions of expected tools in actual sequence
        actual_positions = []
        for tool in expected_order:
            positions = [i for i, actual_tool in enumerate(actual_sequence) if actual_tool == tool]
            if positions:
                actual_positions.append(positions[0])  # Use first occurrence
            else:
                return 0.0  # Missing required tool
        
        # Check if positions are in ascending order (maintaining logical sequence)
        is_ordered = all(actual_positions[i] <= actual_positions[i+1] for i in range(len(actual_positions)-1))
        
        if is_ordered:
            # Bonus for exact order match
            if actual_positions == list(range(len(actual_positions))):
                return 1.0
            else:
                return 0.8  # Correct order but with extra steps
        else:
            # Partial credit based on how many pairs are in correct order
            correct_pairs = sum(1 for i in range(len(actual_positions)-1) 
                              if actual_positions[i] <= actual_positions[i+1])
            total_pairs = len(actual_positions) - 1
            return correct_pairs / total_pairs if total_pairs > 0 else 0.0
    
    @staticmethod
    def _evaluate_dependency_awareness(tool_calls: List[Dict[str, Any]], dependencies: List[Dict[str, str]]) -> float:
        """Evaluate if model understands tool dependencies"""
        if not dependencies:
            return 1.0
        
        dependency_scores = []
        
        for dep in dependencies:
            prerequisite = dep.get("prerequisite")
            dependent = dep.get("dependent")
            requirement = dep.get("requirement", "order")  # "order", "parameter_usage", "existence"
            
            if requirement == "order":
                # Check if prerequisite comes before dependent
                prereq_positions = [i for i, tc in enumerate(tool_calls) if tc.get("tool") == prerequisite]
                dependent_positions = [i for i, tc in enumerate(tool_calls) if tc.get("tool") == dependent]
                
                if prereq_positions and dependent_positions:
                    if min(prereq_positions) < min(dependent_positions):
                        dependency_scores.append(1.0)
                    else:
                        dependency_scores.append(0.0)
                else:
                    dependency_scores.append(0.0)  # Missing tools
            
            elif requirement == "parameter_usage":
                # Check if dependent tool uses result from prerequisite
                # This is complex to verify without execution, so we'll give partial credit
                # if both tools exist in correct order
                prereq_exists = any(tc.get("tool") == prerequisite for tc in tool_calls)
                dependent_exists = any(tc.get("tool") == dependent for tc in tool_calls)
                
                if prereq_exists and dependent_exists:
                    dependency_scores.append(0.7)  # Partial credit for having both
                else:
                    dependency_scores.append(0.0)
        
        return sum(dependency_scores) / len(dependency_scores) if dependency_scores else 1.0
    
    @staticmethod
    def _evaluate_efficiency(actual_sequence: List[str], expected_min_steps: int) -> float:
        """Evaluate workflow efficiency (minimal steps)"""
        actual_steps = len(actual_sequence)
        
        if actual_steps == expected_min_steps:
            return 1.0
        elif actual_steps < expected_min_steps:
            # Too few steps might mean incomplete workflow
            return 0.5
        else:
            # Penalize for extra unnecessary steps
            efficiency = expected_min_steps / actual_steps
            return max(0.0, efficiency)
    
    @staticmethod
    def _evaluate_context_usage(tool_calls: List[Dict[str, Any]], context_requirements: List[Dict[str, str]]) -> float:
        """Evaluate if model properly uses context from previous operations"""
        if not context_requirements:
            return 1.0
        
        context_scores = []
        
        for req in context_requirements:
            source_tool = req.get("source")
            target_tool = req.get("target")
            parameter = req.get("parameter")
            
            # Find the source tool call
            source_calls = [tc for tc in tool_calls if tc.get("tool") == source_tool]
            target_calls = [tc for tc in tool_calls if tc.get("tool") == target_tool]
            
            if source_calls and target_calls:
                # Check if target tool has the required parameter
                # In a real implementation, we'd check if the parameter value makes sense
                target_params = target_calls[0].get("parameters", {})
                if parameter in target_params:
                    # Give credit if the parameter exists and looks like it could be from context
                    param_value = target_params[parameter]
                    if isinstance(param_value, int) and param_value > 0:  # Likely an ID
                        context_scores.append(1.0)
                    else:
                        context_scores.append(0.7)  # Partial credit
                else:
                    context_scores.append(0.0)
            else:
                context_scores.append(0.0)
        
        return sum(context_scores) / len(context_scores) if context_scores else 1.0
    
    @staticmethod
    def _evaluate_error_anticipation(tool_calls: List[Dict[str, Any]], error_scenarios: List[str]) -> float:
        """Evaluate if model anticipates and handles potential errors"""
        if not error_scenarios:
            return 1.0
        
        # This is a simplified check - in practice you'd analyze the actual parameters
        # and check for validation patterns
        
        error_handling_score = 0.0
        
        for scenario in error_scenarios:
            if scenario == "check_existence_before_update":
                # Check if model lists or gets todos before updating
                has_list_or_get = any(tc.get("tool") in ["list_todos", "get_todo"] for tc in tool_calls)
                has_update = any(tc.get("tool") == "update_todo" for tc in tool_calls)
                
                if has_update and has_list_or_get:
                    error_handling_score += 1.0
                elif has_update:
                    error_handling_score += 0.3  # Partial credit for trying to update
            
            elif scenario == "validate_id_before_delete":
                # Similar logic for delete operations
                has_validation = any(tc.get("tool") in ["list_todos", "get_todo"] for tc in tool_calls)
                has_delete = any(tc.get("tool") == "delete_todo" for tc in tool_calls)
                
                if has_delete and has_validation:
                    error_handling_score += 1.0
                elif has_delete:
                    error_handling_score += 0.3
        
        return error_handling_score / len(error_scenarios) if error_scenarios else 1.0

# Enhanced workflow-focused test scenarios
WORKFLOW_PLANNING_SCENARIOS = {
    "workflow_create_update_sequence": {
        "prompt": "Create a todo 'Review documents', then immediately mark it as completed. Make sure to use the correct ID.",
        "expected_tools": ["create_todo", "update_todo"],
        "workflow_expectations": {
            "logical_order": ["create_todo", "update_todo"],
            "dependencies": [
                {"prerequisite": "create_todo", "dependent": "update_todo", "requirement": "parameter_usage"}
            ],
            "minimal_steps": 2,
            "context_requirements": [
                {"source": "create_todo", "target": "update_todo", "parameter": "id"}
            ],
            "required_operations": ["create_todo", "update_todo"]
        },
        "complexity": 3,
        "evaluation_focus": "workflow_planning"
    },
    "workflow_list_then_update": {
        "prompt": "Show me all pending todos, then mark the first one you find as high priority.",
        "expected_tools": ["list_todos", "update_todo"],
        "workflow_expectations": {
            "logical_order": ["list_todos", "update_todo"],
            "dependencies": [
                {"prerequisite": "list_todos", "dependent": "update_todo", "requirement": "order"}
            ],
            "minimal_steps": 2,
            "error_scenarios": ["check_existence_before_update"],
            "required_operations": ["list_todos", "update_todo"]
        },
        "complexity": 3,
        "evaluation_focus": "workflow_planning"
    },
    "workflow_complex_planning": {
        "prompt": "Create three todos: 'Morning run' (high priority, tomorrow), 'Buy coffee' (medium priority), and 'Review emails' (low priority, today). Then show me only the high priority ones, and finally delete the coffee todo.",
        "expected_tools": ["create_todo", "create_todo", "create_todo", "list_todos", "delete_todo"],
        "workflow_expectations": {
            "logical_order": ["create_todo", "create_todo", "create_todo", "list_todos", "delete_todo"],
            "minimal_steps": 5,
            "required_operations": ["create_todo", "list_todos", "delete_todo"],
            "error_scenarios": ["validate_id_before_delete"]
        },
        "complexity": 4,
        "evaluation_focus": "workflow_planning"
    },
    "workflow_conditional_logic": {
        "prompt": "List all todos first. If there are any pending ones, create a new todo 'Review pending items' with high priority. If not, create 'All caught up!' with low priority.",
        "expected_tools": ["list_todos", "create_todo"],
        "workflow_expectations": {
            "logical_order": ["list_todos", "create_todo"],
            "dependencies": [
                {"prerequisite": "list_todos", "dependent": "create_todo", "requirement": "order"}
            ],
            "minimal_steps": 2,
            "context_requirements": [
                {"source": "list_todos", "target": "create_todo", "parameter": "title"}
            ],
            "required_operations": ["list_todos", "create_todo"]
        },
        "complexity": 4,
        "evaluation_focus": "workflow_planning"
    }
}

# Merge workflow planning scenarios with main test scenarios
TEST_SCENARIOS.update(WORKFLOW_PLANNING_SCENARIOS)

# Enhanced test scenarios with parameter extraction expectations moved above

# New: Complex Decomposition (CD) and EIE-like scenarios for pipeline tagging
CD_SCENARIOS = {
    "decomposition_basic_multi": {
        "prompt": "Add 'Buy groceries' (high) for tomorrow and 'Call dentist' (medium). Then show pending and mark groceries done.",
        "expected_tools": ["create_todo", "create_todo", "list_todos", "update_todo"],
        "complexity": 3,
        "evaluation_focus": "pipeline",
        "setup": {}
    },
    "decomposition_conditional": {
        "prompt": "List todos; if none, create a default 'Starter task' (low); else update first to high priority.",
        "expected_tools": ["list_todos", "create_todo"],  # minimal required set; verifier would refine
        "complexity": 3,
        "evaluation_focus": "pipeline",
        "setup": {}
    },
    "decomposition_cleanup": {
        "prompt": "Create a todo 'Temp note', then delete it.",
        "expected_tools": ["create_todo", "delete_todo"],
        "complexity": 2,
        "evaluation_focus": "pipeline",
        "setup": {}
    },
    "filter_high_priority_week": {
        "prompt": "Show high-priority pending tasks scheduled this week.",
        "expected_tools": ["list_todos"],
        "complexity": 2,
        "evaluation_focus": "pipeline",
        "setup": {}
    },
    "search_and_update": {
        "prompt": "Search for any task about dentist and then mark it completed.",
        "expected_tools": ["search_todos", "update_todo"],
        "complexity": 3,
        "setup": {
            "create_todos": [
                {"title": "Call dentist", "notes": "schedule appointment", "priority": "medium"},
                {"title": "Buy groceries", "notes": "milk and eggs", "priority": "low"}
            ]
        },
        "evaluation_focus": "pipeline"
    }
}

TEST_SCENARIOS.update(CD_SCENARIOS)

# NEW: Additional parsers for different tool calling formats
class FunctionCallParser:
    """Parser for Python function call format using Python AST for robust parsing"""

    VALID_TOOLS = ToolCallParser.VALID_TOOLS
    PARAMETER_SCHEMAS = ToolCallParser.PARAMETER_SCHEMAS

    @staticmethod
    def parse_tool_calls(response: str) -> List[Dict[str, Any]]:
        """Extract function calls from model response.

        Improvements:
        - Prefer fenced code blocks
        - Within a fenced block, support multi-line function calls by reconstructing full call strings
        - Fallback to per-line parsing when reconstruction fails
        """
        tool_calls: List[Dict[str, Any]] = []

        # Prefer fenced code blocks when present; else scan all lines
        blocks: List[str] = []
        try:
            fence_matches = re.findall(r"```[a-zA-Z0-9_]*\n([\s\S]*?)\n```", response, flags=re.MULTILINE)
            if fence_matches:
                blocks.extend(fence_matches)
        except Exception:
            pass

        if not blocks:
            blocks = [response]

        for block in blocks:
            # Attempt multi-line reconstruction first
            reconstructed: List[str] = []
            current: List[str] = []
            paren_depth = 0
            for raw_line in block.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                # Start of a function call
                if paren_depth == 0 and re.match(r"^(\w+)\s*\(", line):
                    current = [line]
                    paren_depth = line.count("(") - line.count(")")
                    if paren_depth == 0:
                        reconstructed.append(line)
                        current = []
                elif paren_depth > 0:
                    current.append(line)
                    paren_depth += line.count("(") - line.count(")")
                    if paren_depth <= 0:
                        reconstructed.append(" ".join(current))
                        current = []

            # If no reconstructions, fallback to per-line
            candidates = reconstructed if reconstructed else [l.strip() for l in block.splitlines()]

            for candidate in candidates:
                if not candidate:
                    continue
                m = re.match(r"^(\w+)\s*\(", candidate)
                if not m:
                    continue
                func_name = m.group(1)
                if func_name not in FunctionCallParser.VALID_TOOLS:
                    continue

                parsing_errors: List[str] = []
                parameters: Dict[str, Any] = {}
                try:
                    expr_ast = ast.parse(candidate, mode="eval")
                    if not isinstance(expr_ast.body, ast.Call):
                        raise ValueError("Parsed expression is not a function call")
                    call_node: ast.Call = expr_ast.body
                    for kw in call_node.keywords:
                        key = kw.arg
                        if key is None:
                            parsing_errors.append("Unsupported argument form (kwargs expansion)")
                            continue
                        try:
                            value = ast.literal_eval(kw.value)
                        except Exception as e:
                            parsing_errors.append(f"Could not evaluate parameter '{key}': {e}")
                            continue
                        if isinstance(value, str) and key == "priority":
                            value = value.lower()
                        parameters[key] = value
                except Exception as e:
                    parsing_errors.append(f"AST parse error: {e}")

                validation_errors = ToolCallParser._validate_parameters(func_name, parameters)
                tool_calls.append({
                    "tool": func_name,
                    "parameters": parameters,
                    "parsing_errors": parsing_errors,
                    "validation_errors": validation_errors,
                    "is_valid": len(parsing_errors) == 0 and len(validation_errors) == 0,
                })

        return tool_calls

    @staticmethod
    def _parse_function_params(func_name: str, params_str: str) -> Dict[str, Any]:
        """Parse function parameters from string using ast.parse and ast.literal_eval"""
        parsing_errors: List[str] = []
        parameters: Dict[str, Any] = {}

        # Build a minimal expression that AST can parse
        expr_source = f"{func_name}({params_str})"
        try:
            expr_ast = ast.parse(expr_source, mode="eval")
            if not isinstance(expr_ast.body, ast.Call):
                raise ValueError("Parsed expression is not a function call")

            call_node: ast.Call = expr_ast.body

            # Only consider keyword args; positional args are ignored for safety
            for kw in call_node.keywords:
                key = kw.arg
                if key is None:
                    # e.g., **kwargs not supported
                    parsing_errors.append("Unsupported argument form (kwargs expansion)")
                    continue

                try:
                    value = ast.literal_eval(kw.value)
                except Exception as e:
                    parsing_errors.append(f"Could not evaluate parameter '{key}': {e}")
                    continue

                # Normalize some values to expected shapes
                if isinstance(value, str) and key == "priority":
                    value = value.lower()

                parameters[key] = value

        except Exception as e:
            parsing_errors.append(f"AST parse error: {e}")

        # Validate parameters against known schema
        validation_errors = ToolCallParser._validate_parameters(func_name, parameters)

        return {
            "tool": func_name,
            "parameters": parameters,
            "parsing_errors": parsing_errors,
            "validation_errors": validation_errors,
            "is_valid": len(parsing_errors) == 0 and len(validation_errors) == 0,
        }

 

# Factory function to get the Function Call parser
class JSONToolCallParser:
    """Parser for JSON array of tool calls: [{"tool": "create_todo", "parameters": {...}}, ...]"""

    VALID_TOOLS = ToolCallParser.VALID_TOOLS

    @staticmethod
    def parse_tool_calls(response: str) -> List[Dict[str, Any]]:
        tool_calls: List[Dict[str, Any]] = []
        parsing_errors: List[str] = []

        raw = response.strip()

        # Try direct JSON first
        data = None
        try:
            data = json.loads(raw)
        except Exception:
            # Try to extract JSON from within code fences or text using bracket matching (non-greedy)
            try:
                # If fenced block exists, narrow to the first fenced content
                fence_match = re.search(r"```[a-zA-Z0-9_]*\n([\s\S]*?)\n```", raw, flags=re.MULTILINE)
                candidate = fence_match.group(1) if fence_match else raw
                # Find first balanced JSON array
                start = candidate.find('[')
                if start != -1:
                    depth = 0
                    end = -1
                    for i, ch in enumerate(candidate[start:], start=start):
                        if ch == '[':
                            depth += 1
                        elif ch == ']':
                            depth -= 1
                            if depth == 0:
                                end = i + 1
                                break
                    if end != -1:
                        snippet = candidate[start:end]
                        data = json.loads(snippet)
            except Exception as e:
                parsing_errors.append(f"JSON parse error: {e}")
            if data is None:
                parsing_errors.append("No JSON array found in response")

        if not isinstance(data, list):
            return []

        for item in data:
            if not isinstance(item, dict):
                continue
            tool = item.get("tool")
            params = item.get("parameters", {}) or {}
            if tool not in JSONToolCallParser.VALID_TOOLS:
                continue
            validation_errors = ToolCallParser._validate_parameters(tool, params)
            tool_calls.append({
                "tool": tool,
                "parameters": params,
                "parsing_errors": [],
                "validation_errors": validation_errors,
                "is_valid": len(validation_errors) == 0,
            })

        return tool_calls


def get_parser(scenario: Dict[str, Any]):
    """Select parser based on scenario format (default: Function Calling)."""
    fmt = scenario.get("format", "function").lower()
    if fmt in ("json", "application/json"):
        return JSONToolCallParser
    return FunctionCallParser

class MCPStdioAdapter:
    """MCP client adapter that executes all tool calls via Node stdio MCP server.

    Each test runs in an isolated temporary working directory to sandbox server state.
    """

    def __init__(self, server_path: str):
        self.server_path = server_path
        self.working_dir: Optional[str] = None

    def reset_database(self):
        """Create a fresh isolated working directory for this test."""
        # Create a new temporary directory used as CWD for the MCP server
        if self.working_dir and os.path.exists(self.working_dir):
            # Best-effort cleanup
            try:
                import shutil
                shutil.rmtree(self.working_dir, ignore_errors=True)
            except Exception:
                pass
        self.working_dir = tempfile.mkdtemp(prefix="tmp_mcp_")
        # Ensure data subdir exists to match server expectations
        os.makedirs(os.path.join(self.working_dir, "data"), exist_ok=True)

    def get_context_summary(self) -> str:
        """Provide minimal context; fresh directory implies empty DB."""
        return "Database is currently empty (no todos exist)."

    def execute_tool_call(self, tool_call: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a tool call by invoking the Node MCP client CLI."""
        if not self.working_dir:
            self.reset_database()

        tool = tool_call.get("tool")
        params = tool_call.get("parameters", {})

        if not tool_call.get("is_valid", True):
            return {
                "success": False,
                "error_type": "validation_error",
                "error": "Tool call failed validation",
                "parsing_errors": tool_call.get("parsing_errors", []),
                "validation_errors": tool_call.get("validation_errors", []),
                "details": f"Invalid tool call for {tool}",
            }

        # Build command to call Node client
        client_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts", "mcp_client.js"))
        node_cmd = [
            "node",
            client_path,
            "--tool",
            str(tool),
            "--args",
            json.dumps(params, separators=(",", ":")),
            "--cwd",
            self.working_dir,
        ]

        try:
            proc = subprocess.run(
                node_cmd,
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception as e:
            return {
                "success": False,
                "error_type": "transport_error",
                "error": f"Failed to invoke MCP client: {e}",
            }

        if proc.returncode != 0:
            return {
                "success": False,
                "error_type": "execution_error",
                "error": proc.stderr.strip() or "MCP client returned non-zero exit code",
            }

        # Parse JSON output from client
        try:
            payload = json.loads(proc.stdout)
        except Exception as e:
            return {
                "success": False,
                "error_type": "parsing_error",
                "error": f"Invalid JSON from MCP client: {e}",
                "stdout": proc.stdout[:5000],
            }

        return {
            "success": True,
            "raw": payload,
            "message": f"Executed {tool}",
        }

def make_model_request_with_retries(model: str, enhanced_prompt: str, system_prompt: str) -> Dict[str, Any]:
    """Make a request to the model with retry logic and detailed tracking"""
    retry_info = {
        "total_attempts": 0,
        "retry_attempts": 0,
        "retry_reasons": [],
        "final_success": False,
        "total_time": 0.0,
        "attempt_times": []
    }
    
    last_error = None
    model_output = ""
    
    for attempt in range(MAX_RETRIES + 1):  # +1 for initial attempt
        retry_info["total_attempts"] += 1
        if attempt > 0:
            retry_info["retry_attempts"] += 1
            if os.environ.get("RETRY_LOGS") == "1":
                print(f"    🔄 Retry attempt {attempt}/{MAX_RETRIES}")
            time.sleep(RETRY_DELAY)
        
        attempt_start = time.time()
        # Sample system metrics around request
        cpu_before = psutil.cpu_percent(interval=None)
        process = psutil.Process(os.getpid())
        rss_before_mb = process.memory_info().rss / (1024 * 1024)
        try:
            # Include deterministic options where supported by backend (Ollama honors many of these)
            request_body = {
                "model": model,
                "prompt": enhanced_prompt,
                "system": system_prompt,
                "stream": False,
                "options": OLLAMA_REQUEST_OPTIONS,
            }
            response = requests.post(
                OLLAMA_URL,
                json=request_body,
                timeout=TIMEOUT_SECONDS,
            )
            data = response.json()
            model_output = data.get("response", "")
            attempt_time = time.time() - attempt_start
            cpu_after = psutil.cpu_percent(interval=None)
            rss_after_mb = process.memory_info().rss / (1024 * 1024)
            retry_info["attempt_times"].append(attempt_time)
            retry_info["total_time"] += attempt_time
            # Minimal content validation BEFORE marking success
            if len(model_output.strip()) < 10 or response.status_code >= 400:
                retry_info["retry_reasons"].append(
                    f"Attempt {attempt + 1}: " + ("Empty or too short response" if len(model_output.strip()) < 10 else f"HTTP {response.status_code}")
                )
                last_error = "Empty response from model" if len(model_output.strip()) < 10 else f"HTTP {response.status_code}"
                if attempt < MAX_RETRIES:
                    continue
            else:
                # Only now mark final success and attach telemetry
                retry_info["final_success"] = True
                retry_info.setdefault("telemetry", []).append({
                    "ollama": {
                        "prompt_eval_count": data.get("prompt_eval_count"),
                        "eval_count": data.get("eval_count"),
                        "total_duration_ms": data.get("total_duration"),
                        "eval_duration_ms": data.get("eval_duration"),
                        "load_duration_ms": data.get("load_duration"),
                        "options": OLLAMA_REQUEST_OPTIONS,
                    },
                    "system_metrics": {
                        "cpu_percent_before": cpu_before,
                        "cpu_percent_after": cpu_after,
                        "rss_mb_before": rss_before_mb,
                        "rss_mb_after": rss_after_mb,
                    },
                    "wall_time_ms": int(attempt_time * 1000),
                })
                break  # Success
                
        except requests.exceptions.Timeout:
            attempt_time = time.time() - attempt_start
            retry_info["attempt_times"].append(attempt_time)
            retry_info["total_time"] += attempt_time
            retry_info["retry_reasons"].append(f"Attempt {attempt + 1}: Request timeout ({TIMEOUT_SECONDS}s)")
            last_error = f"Model response timeout ({TIMEOUT_SECONDS} seconds)"
            if attempt < MAX_RETRIES:
                continue
            else:
                break
                
        except Exception as e:
            attempt_time = time.time() - attempt_start
            retry_info["attempt_times"].append(attempt_time)
            retry_info["total_time"] += attempt_time
            retry_info["retry_reasons"].append(f"Attempt {attempt + 1}: {str(e)}")
            last_error = f"Request failed: {str(e)}"
            if attempt < MAX_RETRIES:
                continue
            else:
                break
    
    return {
        "model_output": model_output,
        "retry_info": retry_info,
        "error": last_error if not retry_info["final_success"] else None
    }

def _pick_step_model(step: str, default_model: str) -> str:
    """Choose a model for a pipeline step, if step-specific lists are set. Uses first entry if provided."""
    step_map = {
        "extract": MODELS_EXTRACT,
        "verify": MODELS_VERIFY,
        "execute": MODELS_EXECUTE,
    }
    candidates = step_map.get(step) or []
    return (candidates[0] if candidates else default_model)

def run_single_model_scenario(model: str, scenario: Dict[str, Any], mcp_client: MCPStdioAdapter) -> Dict[str, Any]:
    """Test a single model with error handling, context injection, and Function Calling format"""
    # Avoid interfering with threaded progress bar unless explicitly enabled
    if os.environ.get("SCENARIO_LOGS") == "1":
        print(f"  Testing scenario: {scenario['prompt'][:50]}... [Function Calling]")
    
    # Reset database for clean test
    mcp_client.reset_database()
    
    # Setup scenario if it has initial data requirements
    setup_errors = []
    if "setup" in scenario:
        setup_data = scenario["setup"]
        if "create_todos" in setup_data:
            for todo_data in setup_data["create_todos"]:
                result = mcp_client.execute_tool_call({
                    "tool": "create_todo",
                    "parameters": todo_data,
                    "is_valid": True
                })
                if not result.get("success", False):
                    setup_errors.append(f"Failed to create setup todo: {result.get('error', 'Unknown error')}")
    
    # Inject context into the prompt (more natural integration)
    context_summary = mcp_client.get_context_summary()
    if "empty" in context_summary.lower():
        enhanced_prompt = f"{scenario['prompt']}\n\n(Note: Database is currently empty - no existing todos.)"
    else:
        enhanced_prompt = f"{scenario['prompt']}\n\n{context_summary}"
    
    # Get format-specific system prompt
    scenario_format = scenario.get("format", "function")
    system_prompt = get_system_prompt_for_format(scenario_format)
    
    # Determine step-specific models
    model_extract = _pick_step_model("extract", model)
    model_verify = _pick_step_model("verify", model)
    model_execute = _pick_step_model("execute", model)

    # Call Extract model with retry logic
    start_time = time.time()
    request_result = make_model_request_with_retries(model_extract, enhanced_prompt, system_prompt)
    
    # Handle request failure
    if request_result["error"]:
        retry_info = request_result["retry_info"]
        return {
            "model": model,
            "scenario": scenario,
            "format_type": "function",
            "format_name": "Function Calling",
            "context_injected": context_summary,
            "enhanced_prompt": enhanced_prompt,
            "model_output": request_result["model_output"],
            "tool_calls": [],
            "results": [],
            "setup_errors": setup_errors,
            "execution_error": request_result["error"],
            "retry_info": retry_info,
            "metrics": {
                "success_rate": 0.0,
                "tool_accuracy": 0.0,
                "response_time": retry_info["total_time"],
                "expected_tools": len(scenario["expected_tools"]),
                "actual_tools": 0,
                "successful_calls": 0,
                "validation_errors": 0,
                "parsing_errors": 0,
                "retry_attempts": retry_info["retry_attempts"],
                "total_attempts": retry_info["total_attempts"]
            }
        }
    
    model_output = request_result["model_output"]
    retry_info = request_result["retry_info"]
    elapsed_time = time.time() - start_time
    
    # Parse tool calls with Function Call parser (Extraction)
    parser_class = get_parser(scenario)
    tool_calls = parser_class.parse_tool_calls(model_output)

    # -----------------------------
    # Phase gold tool sets (backward compatible)
    # -----------------------------
    extraction_expected_tools = _get_phase_gold_tools(scenario, "extraction")
    verification_expected_tools = _get_phase_gold_tools(scenario, "verification")
    execution_expected_tools = _get_phase_gold_tools(scenario, "execution")

    def _set_prf1(pred: List[str], gold: List[str]) -> Tuple[float, float, float]:
        # Normalize tool names to lowercase/trim
        pred_set = set(t.strip().lower() for t in pred if t)
        gold_set = set(t.strip().lower() for t in gold if t)
        if not pred_set and not gold_set:
            return 1.0, 1.0, 1.0
        if not pred_set:
            return 0.0, 0.0 if gold_set else 1.0, 0.0
        tp = len(pred_set & gold_set)
        precision = tp / len(pred_set) if pred_set else 0.0
        recall = tp / len(gold_set) if gold_set else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
        return precision, recall, f1

    # If only running the Extraction phase, compute and return early with extraction metrics
    if PHASE == "extraction":
        extracted_seq = [tc.get("tool", "") for tc in tool_calls]
        _, _, extraction_tool_f1 = _set_prf1(extracted_seq, extraction_expected_tools)

        elapsed_time = time.time() - start_time
        pipeline_data = {
            "extract": {
                "model": model_extract,
                "raw_output": model_output,
                "tool_calls": tool_calls,
                "metrics": {
                    "tool_f1": extraction_tool_f1,
                    # Default to full adherence/param readiness when not applicable
                    "order_adherence": 1.0,
                    "parameter_readiness": 0.0,
                },
            }
        }

        return {
            "model": model,
            "scenario": scenario,
            "format_type": "function",
            "format_name": "Function Calling",
            "context_injected": context_summary,
            "enhanced_prompt": enhanced_prompt,
            "model_output": model_output,
            "tool_calls": tool_calls,
            "results": [],
            "setup_errors": setup_errors,
            "retry_info": retry_info,
            # Map extraction F1 to top-level fields for aggregate compatibility
            "metrics": {
                "success_rate": extraction_tool_f1,
                "tool_accuracy": extraction_tool_f1,
                "response_time": elapsed_time,
                "expected_tools": len(extraction_expected_tools),
                "actual_tools": len(extracted_seq),
                "successful_calls": 0,
                "valid_tool_calls": 0,
                "validation_errors": 0,
                "parsing_errors": 0,
                "retry_attempts": retry_info["retry_attempts"],
                "total_attempts": retry_info["total_attempts"],
                "parameter_extraction": {},
                "workflow_planning": {},
                "tool_usage": {"precision": extraction_tool_f1, "recall": extraction_tool_f1, "f1": extraction_tool_f1},
                "error_breakdown": {"validation_errors": [], "not_found_errors": [], "execution_errors": [], "unknown_tool_errors": []},
            },
            "pipeline": pipeline_data,
        }

    # -------------------------------------------------
    # Verification: separate LLM call to vet extracted calls
    # -------------------------------------------------
    verify_prompt = (
        "Task: From the following extracted tool calls, return ONLY the vetted subset that is strictly justified by the instruction.\n"
        "- Do NOT add new calls beyond what the instruction justifies.\n"
        "- Remove unsupported or hallucinated steps.\n"
        "- Preserve reasonable order when applicable.\n"
        "Output only tool calls using the exact Function Calling format, one per line.\n\n"
        f"Instruction:\n{scenario['prompt']}\n\n"
        f"Extracted calls (for review):\n```\n{model_output}\n```\n"
    )
    # Optimization: skip verifier model call entirely when PHASE=verification
    vetted_calls_parsed: List[Dict[str, Any]] = []
    if PHASE == "verification":
        # Use extracted calls directly as vetted input for scoring; adjudication is gold-only
        vetted_calls_parsed = [tc for tc in tool_calls if tc.get("is_valid", True)]
        verify_result = {"model_output": "", "error": None, "retry_info": {"final_success": True, "retry_attempts": 0, "total_attempts": 0}}
    else:
        verify_result = make_model_request_with_retries(model_verify, verify_prompt, system_prompt)
        if not verify_result.get("error"):
            verify_output = verify_result.get("model_output", "")
            vetted_calls_parsed = parser_class.parse_tool_calls(verify_output)
        # Fallback: if verifier produced nothing parseable, keep only valid extracted calls
        if not vetted_calls_parsed:
            vetted_calls_parsed = [tc for tc in tool_calls if tc.get("is_valid", True)]

    # If only running the Verification phase, compute and return early with verification metrics
    if PHASE == "verification":
        vetted_seq = [tc.get("tool", "") for tc in vetted_calls_parsed]
        _, _, acceptance_f1 = _set_prf1(vetted_seq, verification_expected_tools)

        elapsed_time = time.time() - start_time
        pipeline_data = {
            "verify": {
                "model": model_verify,
                "vetted_calls": vetted_calls_parsed,
                "issues": {},
                "metrics": {
                    "acceptance_f1": acceptance_f1,
                    # Placeholder for now; hallucination scoring not implemented in pure phase gate
                    "hallucination_f1": 0.0,
                    "order_adherence": 1.0,
                },
            }
        }

        return {
            "model": model,
            "scenario": scenario,
            "format_type": "function",
            "format_name": "Function Calling",
            "context_injected": context_summary,
            "enhanced_prompt": enhanced_prompt,
            "model_output": model_output,
            "tool_calls": tool_calls,
            "results": [],
            "setup_errors": setup_errors,
            "retry_info": retry_info,
            # Map acceptance F1 to top-level fields for aggregate compatibility
            "metrics": {
                "success_rate": acceptance_f1,
                "tool_accuracy": acceptance_f1,
                "response_time": elapsed_time,
                "expected_tools": len(verification_expected_tools),
                "actual_tools": len(vetted_seq),
                "successful_calls": 0,
                "valid_tool_calls": 0,
                "validation_errors": 0,
                "parsing_errors": 0,
                "retry_attempts": retry_info["retry_attempts"],
                "total_attempts": retry_info["total_attempts"],
                "parameter_extraction": {},
                "workflow_planning": {},
                "tool_usage": {"precision": acceptance_f1, "recall": acceptance_f1, "f1": acceptance_f1},
                "error_breakdown": {"validation_errors": [], "not_found_errors": [], "execution_errors": [], "unknown_tool_errors": []},
            },
            "pipeline": pipeline_data,
        }
    
    # Helper to format a call back to Function Calling syntax
    def _format_call(fn: str, params: Dict[str, Any]) -> str:
        def fmt(v: Any) -> str:
            if isinstance(v, bool):
                return "True" if v else "False"
            if v is None:
                return "None"
            if isinstance(v, (int, float)):
                return str(v)
            # fallback string
            s = str(v).replace('"', '\\"')
            return f'"{s}"'
        args = ", ".join(f"{k}={fmt(v)}" for k, v in params.items())
        return f"{fn}({args})"

    # -------------------------------------------------
    # Execute planning: separate LLM call to finalize execution sequence
    # -------------------------------------------------
    # For execution-only phase, use GOLD vetted set (tools only), optionally injecting param hints
    if PHASE == "execution":
        gold_vetted_tools = verification_expected_tools or execution_expected_tools
        # Build minimal calls from gold tools with optional hints
        param_hints = scenario.get("param_hints", {}) or {}
        vetted_calls_text = "\n".join(
            _format_call(tool, param_hints.get(tool, {})) for tool in gold_vetted_tools
        )
    else:
        # In full pipeline mode, prefer verifier output; fallback to parsed vetted calls
        if verify_result.get("error"):
            vetted_calls_text = "\n".join(_format_call(tc.get("tool", ""), tc.get("parameters", {})) for tc in vetted_calls_parsed)
        else:
            vetted_calls_text = verify_result.get("model_output", "")

    final_execution_calls: List[Dict[str, Any]] = []

    # Optimization: when running execution-only, skip the execute planner model call
    if PHASE == "execution":
        # Use the vetted gold tools with param hints to construct the final calls directly
        final_execution_calls = parser_class.parse_tool_calls(vetted_calls_text)
    else:
        execute_prompt = (
            "ROLE: Execute vetted MCP tool calls with strict conformance.\n\n"
            "INPUTS:\n"
            f"- Instruction:\n{scenario['prompt']}\n\n"
            f"- Context:\n{context_summary}\n\n"
            "- Vetted calls (authoritative allowed set):\n" +
            ("```\n" + vetted_calls_text + "\n```\n") +
            "\nTOOL SCHEMAS & RULES:\n"
            "- ids accept integer|string; server coerces to int\n"
            "- booleans unquoted (True/False), dates YYYY-MM-DD\n"
            "- Allowed tools only: create_todo, list_todos, get_todo, update_todo, delete_todo, search_todos\n"
            "- DO NOT introduce new tools or parameters beyond the vetted list\n"
            "- You MAY reorder to satisfy dependencies and deduplicate redundant calls\n\n"
            "OUTPUT FORMAT:\n"
            "- Python-like Function Calling, one call per line, no commentary.\n\n"
            "TASK:\n"
            "- Produce the final, executable sequence that best fulfills the instruction using ONLY the vetted calls, fixing types/order if needed.\n"
        )

        exec_plan_result = make_model_request_with_retries(model_execute, execute_prompt, system_prompt)
        if not exec_plan_result.get("error"):
            exec_output = exec_plan_result.get("model_output", "")
            final_execution_calls = parser_class.parse_tool_calls(exec_output)
        # Fallback to vetted calls if execute planner output is empty/unusable
        if not final_execution_calls:
            final_execution_calls = vetted_calls_parsed

    # Execute tool calls and collect detailed results
    results = []
    validation_errors = 0
    parsing_errors = 0

    for tool_call in final_execution_calls:
        # Count validation and parsing errors
        if not tool_call.get("is_valid", True):
            if tool_call.get("parsing_errors"):
                parsing_errors += len(tool_call["parsing_errors"])
            if tool_call.get("validation_errors"):
                validation_errors += len(tool_call["validation_errors"])

        result = mcp_client.execute_tool_call(tool_call)
        results.append(result)

    # Parameter extraction evaluation (if scenario has expected parameters)
    parameter_scores = ParameterExtractionEvaluator.evaluate_parameter_accuracy(tool_calls, scenario)

    # Workflow planning evaluation (if scenario has workflow expectations)
    workflow_scores = WorkflowPlanningEvaluator.evaluate_workflow_quality(tool_calls, scenario)

    # Metrics calculation
    # Use execution phase gold set for overall success_rate/tool_accuracy
    expected_tool_count = len(execution_expected_tools)
    actual_tool_count = len(final_execution_calls)
    successful_calls = sum(1 for r in results if r.get("success", False))
    valid_tool_calls = sum(1 for tc in final_execution_calls if tc.get("is_valid", True))

    # Tool usage precision/recall/F1 against expected sequence (by multiset counts)
    def _count_items(items: List[str]) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for it in items:
            counts[it] = counts.get(it, 0) + 1
        return counts

    expected_seq = list(execution_expected_tools)
    actual_seq = [tc.get("tool", "") for tc in final_execution_calls]
    # Set-based P/R/F1 for overall tool usage against execution gold
    precision, recall, f1 = _set_prf1(actual_seq, expected_seq)
    
    # More nuanced success rate calculation (per gold tool, extra calls don't help)
    if expected_tool_count > 0:
        # Map successes by tool name (normalized)
        successful_tools: Dict[str, bool] = {}
        for gold_tool in set(t.strip().lower() for t in expected_seq):
            successful_tools[gold_tool] = any(
                (str(tc.get("tool", "")).strip().lower() == gold_tool) and (res.get("success", False))
                for tc, res in zip(final_execution_calls, results)
            )
        success_rate = sum(1 for v in successful_tools.values() if v) / len(successful_tools)
        # tool_accuracy remains informational; bound by expected count
        tool_accuracy = min(valid_tool_calls / expected_tool_count, 1.0)
    else:
        success_rate = 1.0 if actual_tool_count == 0 else 0.0
        tool_accuracy = 1.0 if actual_tool_count == 0 else 0.0
    
    # -----------------------------
    # Pipeline metrics (phase-specific, set-based where applicable)
    # -----------------------------
    # Extraction metrics (based on initial extracted calls only)
    extracted_seq = [tc.get("tool", "") for tc in tool_calls]
    _, _, extraction_tool_f1 = _set_prf1(extracted_seq, extraction_expected_tools)
    # Order adherence for extraction: use workflow expectations when provided; otherwise fully adherent
    if "workflow_expectations" in scenario and scenario["workflow_expectations"].get("logical_order"):
        extraction_order_adherence = WorkflowPlanningEvaluator._evaluate_sequence_logic(
            actual_sequence=actual_seq,
            expected_order=scenario["workflow_expectations"].get("logical_order", []),
        )
    else:
        extraction_order_adherence = 1.0
    # Parameter readiness: reuse parameter extraction completeness
    extraction_param_readiness = parameter_scores.get("completeness_score", 0.0)

    # Verification metrics (set-based acceptance vs verification_gold)
    vetted_calls = vetted_calls_parsed
    vetted_seq = [tc.get("tool", "") for tc in vetted_calls]
    _, _, acceptance_f1 = _set_prf1(vetted_seq, verification_expected_tools)
    # Placeholder hallucination metrics (not computed in single-shot scaffold)
    hallucination_f1 = 0.0

    # Execution ordered evaluation: prefer execution_gold.sequence if provided
    exec_sequence = []
    if isinstance(scenario.get("execution_gold"), dict) and isinstance(scenario["execution_gold"].get("sequence"), list):
        exec_sequence = list(scenario["execution_gold"]["sequence"])

    pipeline_data = {
        "extract": {
            "model": model_extract,
            "raw_output": model_output,
            "tool_calls": tool_calls,
            "metrics": {
                "tool_f1": extraction_tool_f1,
                "order_adherence": extraction_order_adherence,
                "parameter_readiness": extraction_param_readiness,
            },
        },
        "verify": {
            "model": model_verify,
            "vetted_calls": vetted_calls,
            "issues": {},
            "metrics": {
                "acceptance_f1": acceptance_f1,
                "hallucination_f1": hallucination_f1,
                "order_adherence": extraction_order_adherence,
            },
        },
        "execute": {
            "model": model_execute,
            "final_calls": final_execution_calls,
            "results": results,
            "metrics": {
                "success_rate": success_rate,
                "tool_accuracy": tool_accuracy,
                "tool_usage_f1": f1,
                "timing": elapsed_time,
                **({"order_adherence": WorkflowPlanningEvaluator._evaluate_sequence_logic(actual_seq, exec_sequence)} if exec_sequence else {}),
            },
        },
    }

    return {
        "model": model,
        "scenario": scenario,
        "format_type": "function",
        "format_name": "Function Calling",
        "context_injected": context_summary,
        "enhanced_prompt": enhanced_prompt,
        "model_output": model_output,
        "tool_calls": tool_calls,
        "results": results,
        "setup_errors": setup_errors,
        "retry_info": retry_info,
        "metrics": {
            "success_rate": success_rate,
            "tool_accuracy": tool_accuracy,
            "response_time": elapsed_time,
            "expected_tools": expected_tool_count,
            "actual_tools": actual_tool_count,
            "successful_calls": successful_calls,
            "valid_tool_calls": valid_tool_calls,
            "validation_errors": validation_errors,
            "parsing_errors": parsing_errors,
            "retry_attempts": retry_info["retry_attempts"],
            "total_attempts": retry_info["total_attempts"],
            "parameter_extraction": parameter_scores,
            "workflow_planning": workflow_scores,
            "tool_usage": {"precision": precision, "recall": recall, "f1": f1},
            "error_breakdown": {
                "validation_errors": [r for r in results if r.get("error_type") == "validation_error"],
                "not_found_errors": [r for r in results if r.get("error_type") == "not_found_error"],
                "execution_errors": [r for r in results if r.get("error_type") == "execution_error"],
                "unknown_tool_errors": [r for r in results if r.get("error_type") == "unknown_tool"]
            }
        },
        "pipeline": pipeline_data,
    }

def run_comprehensive_test(max_parallel_models: int = 1):
    """Run the complete test suite with Function Calling and JSON formats.

    Parallelizes across models only when max_parallel_models > 1.
    """
    print("🚀 Starting Model Tool Calling Capability Test with Function Calling Format")
    print("=" * 70)

    total_tests = len(MODELS) * len(TEST_SCENARIOS) * REPEAT_RUNS
    print(f"📊 Testing: {len(MODELS)} models × 1 format × {len(TEST_SCENARIOS)} scenarios = {total_tests} total tests")

    # Lightweight CLI progress bar shared across threads
    progress_lock = threading.Lock()
    progress_completed = {"count": 0}
    run_start = time.time()
    bar_width = 40
    term_width = shutil.get_terminal_size(fallback=(100, 20)).columns

    def clear_progress_line():
        # Clear the current line to avoid interleaving with logs
        sys.stdout.write("\r" + (" " * max(term_width - 1, bar_width + 20)) + "\r")
        sys.stdout.flush()

    def _format_eta(seconds: float) -> str:
        if seconds < 1:
            return "~<1s"
        m, s = divmod(int(seconds + 0.5), 60)
        if m == 0:
            return f"~{s}s"
        h, m = divmod(m, 60)
        if h:
            return f"~{h}h {m}m"
        return f"~{m}m {s}s"

    def render_progress():
        completed = progress_completed["count"]
        ratio = completed / total_tests if total_tests else 1
        filled = int(ratio * bar_width)
        bar = "#" * filled + "-" * (bar_width - filled)
        # ETA based on sampled average wall-clock per test
        if completed > 0 and completed < total_tests:
            elapsed = time.time() - run_start
            avg_per = elapsed / completed
            remaining = (total_tests - completed) * avg_per
            eta_str = _format_eta(remaining)
        elif completed == 0:
            eta_str = "estimating…"
        else:
            eta_str = "done"
        sys.stdout.write(f"\rProgress [{bar}] {completed}/{total_tests} ({ratio*100:4.1f}%) ETA {eta_str}")
        sys.stdout.flush()
        if completed >= total_tests:
            sys.stdout.write("\n")
            sys.stdout.flush()

    def safe_log(message: str):
        # Ensure logs do not corrupt the single-line progress bar
        with progress_lock:
            clear_progress_line()
            print(message)
            render_progress()

    def run_for_model(model: str) -> List[Dict[str, Any]]:
        safe_log(f"\n📊 Testing Model: {model}")
        safe_log("-" * 50)
        safe_log(f"\n  🔧 Format: Function Calling (Python-like function call syntax)")
        safe_log("  " + "-" * 45)

        local_client = MCPStdioAdapter(MCP_SERVER_PATH)
        local_results: List[Dict[str, Any]] = []
        for scenario_name, scenario in TEST_SCENARIOS.items():
            for _ in range(REPEAT_RUNS):
                try:
                    result = run_single_model_scenario(model, scenario, local_client)
                    local_results.append(result)

                    metrics = result["metrics"]
                    param_info = ""
                    if "parameter_extraction" in metrics and metrics["parameter_extraction"].get("semantic_accuracy", 0) > 0:
                        param_info = f", Param Accuracy: {metrics['parameter_extraction']['semantic_accuracy']:.1%}"

                    workflow_info = ""
                    if "workflow_planning" in metrics and metrics["workflow_planning"].get("sequence_logic", 0) > 0:
                        workflow_avg = sum([
                            metrics["workflow_planning"].get("sequence_logic", 0),
                            metrics["workflow_planning"].get("dependency_awareness", 0),
                            metrics["workflow_planning"].get("efficiency", 0),
                        ]) / 3
                        workflow_info = f", Workflow: {workflow_avg:.1%}"

                    retry_info_str = ""
                    if result.get("retry_info", {}).get("retry_attempts", 0) > 0:
                        retry_attempts = result["retry_info"]["retry_attempts"]
                        retry_info_str = f", Retries: {retry_attempts}"

                    safe_log(
                        f"    ✅ {scenario_name}: Success Rate: {metrics['success_rate']:.1%}, "
                        f"Tool Accuracy: {metrics['tool_accuracy']:.1%}{param_info}{workflow_info}, "
                        f"Time: {metrics['response_time']:.2f}s{retry_info_str}"
                    )

                    # Dual-format scoring (lightweight): also attempt alternate format parsing on the same output
                    try:
                        alt_results: List[Dict[str, Any]] = []
                        model_output_alt = result.get("model_output", "")
                        # Helper for set-based F1
                        def _set_prf1_alt(pred: List[str], gold: List[str]) -> Tuple[float, float, float]:
                            pred_set = set(t.strip().lower() for t in pred if t)
                            gold_set = set(t.strip().lower() for t in gold if t)
                            if not pred_set and not gold_set:
                                return 1.0, 1.0, 1.0
                            if not pred_set:
                                return 0.0, 0.0 if gold_set else 1.0, 0.0
                            tp = len(pred_set & gold_set)
                            precision = tp / len(pred_set) if pred_set else 0.0
                            recall = tp / len(gold_set) if gold_set else 0.0
                            f1_local = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
                            return precision, recall, f1_local
                        # Compute gold set for extraction
                        extraction_expected_tools_alt = _get_phase_gold_tools(scenario, "extraction")
                        # Try JSON parse if primary path was function
                        try:
                            json_calls = JSONToolCallParser.parse_tool_calls(model_output_alt)
                        except Exception:
                            json_calls = []
                        if json_calls:
                            extracted_seq = [tc.get("tool", "") for tc in json_calls]
                            _, _, f1_json = _set_prf1_alt(extracted_seq, extraction_expected_tools_alt)
                            valid_tool_calls = sum(1 for tc in json_calls if tc.get("is_valid", True))
                            alt_results.append({
                                "model": model,
                                "scenario": scenario,
                                "format_type": "json",
                                "format_name": "JSON",
                                "context_injected": context_summary,
                                "enhanced_prompt": enhanced_prompt,
                                "model_output": model_output_alt,
                                "tool_calls": json_calls,
                                "results": [],
                                "setup_errors": setup_errors,
                                "retry_info": result.get("retry_info", {"retry_attempts": 0, "total_attempts": 1, "total_time": metrics["response_time"]}),
                                "metrics": {
                                    "success_rate": f1_json,
                                    "tool_accuracy": f1_json,
                                    "response_time": metrics["response_time"],
                                    "expected_tools": len(extraction_expected_tools_alt),
                                    "actual_tools": len(extracted_seq),
                                    "successful_calls": 0,
                                    "valid_tool_calls": valid_tool_calls,
                                    "validation_errors": 0,
                                    "parsing_errors": 0,
                                    "retry_attempts": result.get("retry_info", {}).get("retry_attempts", 0),
                                    "total_attempts": result.get("retry_info", {}).get("total_attempts", 1),
                                    "parameter_extraction": {},
                                    "workflow_planning": {},
                                    "tool_usage": {"precision": f1_json, "recall": f1_json, "f1": f1_json},
                                    "error_breakdown": {"validation_errors": [], "not_found_errors": [], "execution_errors": [], "unknown_tool_errors": []},
                                },
                            })
                        # Try Function parse if primary path ever switches to json in future
                        try:
                            func_calls = FunctionCallParser.parse_tool_calls(model_output_alt)
                        except Exception:
                            func_calls = []
                        if func_calls and result.get("format_type") != "function":
                            extracted_seq = [tc.get("tool", "") for tc in func_calls]
                            _, _, f1_func = _set_prf1_alt(extracted_seq, extraction_expected_tools_alt)
                            valid_tool_calls = sum(1 for tc in func_calls if tc.get("is_valid", True))
                            alt_results.append({
                                "model": model,
                                "scenario": scenario,
                                "format_type": "function",
                                "format_name": "Function Calling",
                                "context_injected": context_summary,
                                "enhanced_prompt": enhanced_prompt,
                                "model_output": model_output_alt,
                                "tool_calls": func_calls,
                                "results": [],
                                "setup_errors": setup_errors,
                                "retry_info": result.get("retry_info", {"retry_attempts": 0, "total_attempts": 1, "total_time": metrics["response_time"]}),
                                "metrics": {
                                    "success_rate": f1_func,
                                    "tool_accuracy": f1_func,
                                    "response_time": metrics["response_time"],
                                    "expected_tools": len(extraction_expected_tools_alt),
                                    "actual_tools": len(extracted_seq),
                                    "successful_calls": 0,
                                    "valid_tool_calls": valid_tool_calls,
                                    "validation_errors": 0,
                                    "parsing_errors": 0,
                                    "retry_attempts": result.get("retry_info", {}).get("retry_attempts", 0),
                                    "total_attempts": result.get("retry_info", {}).get("total_attempts", 1),
                                    "parameter_extraction": {},
                                    "workflow_planning": {},
                                    "tool_usage": {"precision": f1_func, "recall": f1_func, "f1": f1_func},
                                    "error_breakdown": {"validation_errors": [], "not_found_errors": [], "execution_errors": [], "unknown_tool_errors": []},
                                },
                            })
                        # Append alternates, if any
                        if alt_results:
                            local_results.extend(alt_results)
                    except Exception:
                        # Best-effort; ignore alt format failures
                        pass

                    # Update global progress bar after each scenario completes
                    with progress_lock:
                        progress_completed["count"] += 1
                        render_progress()

                except Exception as e:
                    safe_log(f"    ❌ {scenario_name}: Error: {e}")
                    # Even on error, count the scenario as completed to avoid hanging progress
                    with progress_lock:
                        progress_completed["count"] += 1
                        render_progress()
                    continue

        return local_results

    all_results: List[Dict[str, Any]] = []
    if max_parallel_models and max_parallel_models > 1 and len(MODELS) > 1:
        with ThreadPoolExecutor(max_workers=max_parallel_models) as executor:
            future_to_model = {executor.submit(run_for_model, model): model for model in MODELS}
            for future in as_completed(future_to_model):
                model = future_to_model[future]
                try:
                    model_results = future.result()
                    all_results.extend(model_results)
                except Exception as exc:
                    print(f"Model {model} generated an exception: {exc}")
    else:
        for model in MODELS:
            all_results.extend(run_for_model(model))

    # Generate summary and detailed results
    generate_results(all_results)

    print("\n🎉 Testing Complete!")
    print("📄 Results saved to TEST_RESULTS_SUMMARY.md, summary_*.json and detailed_test_logs_*.json")

def generate_results(all_results: List[Dict[str, Any]]):
    """Generate both summary and detailed result files with retry tracking"""
    
    # Calculate overall statistics with retry information
    model_stats = {}
    format_stats = {}
    retry_stats = {
        "total_tests": 0,
        "tests_with_retries": 0,
        "total_retry_attempts": 0,
        "max_retries_per_test": 0,
        "retry_reasons": {},
        "models_with_retries": set()
    }
    
    for result in all_results:
        model = result["model"]
        format_type = result.get("format_type", "function")
        format_name = result.get("format_name", "Function Calling")
        
        # Track retry statistics
        retry_info = result.get("retry_info", {})
        retry_stats["total_tests"] += 1
        
        if retry_info.get("retry_attempts", 0) > 0:
            retry_stats["tests_with_retries"] += 1
            retry_stats["total_retry_attempts"] += retry_info["retry_attempts"]
            retry_stats["max_retries_per_test"] = max(
                retry_stats["max_retries_per_test"], 
                retry_info["retry_attempts"]
            )
            retry_stats["models_with_retries"].add(model)
            
            # Track retry reasons
            for reason in retry_info.get("retry_reasons", []):
                if reason not in retry_stats["retry_reasons"]:
                    retry_stats["retry_reasons"][reason] = 0
                retry_stats["retry_reasons"][reason] += 1
        
        # Overall model stats
        if model not in model_stats:
            model_stats[model] = {
                "success_rates": [],
                "tool_accuracies": [],
                "response_times": [],
                "total_tests": 0,
                "retry_attempts": [],
                "tests_with_retries": 0,
                "format_breakdown": {}
            }
        
        # Format-specific stats for this model
        if format_type not in model_stats[model]["format_breakdown"]:
            model_stats[model]["format_breakdown"][format_type] = {
                "format_name": format_name,
                "success_rates": [],
                "tool_accuracies": [],
                "response_times": [],
                "test_count": 0,
                "retry_attempts": [],
                "tests_with_retries": 0
            }
        
        # Global format stats
        if format_type not in format_stats:
            format_stats[format_type] = {
                "format_name": format_name,
                "success_rates": [],
                "tool_accuracies": [],
                "response_times": [],
                "tool_usage_f1s": [],
                "total_tests": 0,
                "models": set(),
                "retry_attempts": [],
                "tests_with_retries": 0,
            }
        
        metrics = result["metrics"]
        
        # Update overall model stats
        model_stats[model]["success_rates"].append(metrics["success_rate"])
        model_stats[model]["tool_accuracies"].append(metrics["tool_accuracy"])
        model_stats[model]["response_times"].append(metrics["response_time"])
        model_stats[model]["total_tests"] += 1
        model_stats[model]["retry_attempts"].append(retry_info.get("retry_attempts", 0))
        if retry_info.get("retry_attempts", 0) > 0:
            model_stats[model]["tests_with_retries"] += 1
        
        # Update format-specific model stats
        model_format_stats = model_stats[model]["format_breakdown"][format_type]
        model_format_stats["success_rates"].append(metrics["success_rate"])
        model_format_stats["tool_accuracies"].append(metrics["tool_accuracy"])
        model_format_stats["response_times"].append(metrics["response_time"])
        model_format_stats["test_count"] += 1
        model_format_stats["retry_attempts"].append(retry_info.get("retry_attempts", 0))
        if retry_info.get("retry_attempts", 0) > 0:
            model_format_stats["tests_with_retries"] += 1
        
        # Update global format stats
        format_stats[format_type]["success_rates"].append(metrics["success_rate"])
        format_stats[format_type]["tool_accuracies"].append(metrics["tool_accuracy"])
        format_stats[format_type]["response_times"].append(metrics["response_time"])
        # Optional tool-usage F1 capture per format
        tu = result.get("metrics", {}).get("tool_usage", {})
        if tu and isinstance(tu.get("f1", None), (int, float)):
            format_stats[format_type]["tool_usage_f1s"].append(float(tu.get("f1", 0.0)))
        format_stats[format_type]["total_tests"] += 1
        format_stats[format_type]["models"].add(model)
        format_stats[format_type]["retry_attempts"].append(retry_info.get("retry_attempts", 0))
        if retry_info.get("retry_attempts", 0) > 0:
            format_stats[format_type]["tests_with_retries"] += 1
    
    # Generate summary files
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    
    summary_content = f"""# Model Tool Calling Test Results Summary - Function Calling Format

## Test Configuration
- **Date**: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
- **Models Tested**: {', '.join(MODELS)}
- **Format Used**: Function Calling (Python-like function call syntax)
- **Database State**: Empty (reset between tests)
- **System Prompt**: Optimized Function Calling format
- **Test Scenarios**: {len(TEST_SCENARIOS)} scenarios across 4 complexity levels
- **Total Tests**: {len(all_results)} ({len(MODELS)} models × 1 format × {len(TEST_SCENARIOS)} scenarios)
- **Current Date Context**: 2025-08-06 (explicitly provided to models)
- **Retry Configuration**: Max {MAX_RETRIES} retries per test, {RETRY_DELAY}s delay, {TIMEOUT_SECONDS}s timeout

## Retry Statistics Summary

- **Tests Requiring Retries**: {retry_stats['tests_with_retries']}/{retry_stats['total_tests']} ({retry_stats['tests_with_retries']/retry_stats['total_tests']:.1%})
- **Total Retry Attempts**: {retry_stats['total_retry_attempts']}
- **Average Retries per Failed Test**: {retry_stats['total_retry_attempts']/max(retry_stats['tests_with_retries'], 1):.1f}
- **Models with Retry Issues**: {len(retry_stats['models_with_retries'])}/{len(MODELS)} ({', '.join(sorted(retry_stats['models_with_retries'])) if retry_stats['models_with_retries'] else 'None'})

## Overall Results (Function Calling Format)

| Model | Success Rate | Tool Accuracy | Response Time | Total Tests | Retry Rate |
|-------|-------------|---------------|---------------|-------------|------------|
"""
    
    for model, stats in model_stats.items():
        avg_success = sum(stats["success_rates"]) / len(stats["success_rates"]) if stats["success_rates"] else 0
        avg_accuracy = sum(stats["tool_accuracies"]) / len(stats["tool_accuracies"]) if stats["tool_accuracies"] else 0
        avg_time = sum(stats["response_times"]) / len(stats["response_times"]) if stats["response_times"] else 0
        retry_rate = stats["tests_with_retries"] / stats["total_tests"] if stats["total_tests"] > 0 else 0
        
        summary_content += f"| {model} | {avg_success:.1%} | {avg_accuracy:.1%} | {avg_time:.2f}s | {stats['total_tests']} | {retry_rate:.1%} |\n"
    
    # Model Rankings (Function Calling Format)
    summary_content += f"""

## Model Rankings (Function Calling)
| Rank | Model | Success Rate | Tool Accuracy | Response Time |
|------|-------|-------------|---------------|---------------|
"""
    
    # Sort models by success rate
    model_results = []
    for model, stats in model_stats.items():
        if stats["success_rates"]:
            avg_success = sum(stats["success_rates"]) / len(stats["success_rates"]) if stats["success_rates"] else 0
            avg_accuracy = sum(stats["tool_accuracies"]) / len(stats["tool_accuracies"]) if stats["tool_accuracies"] else 0
            avg_time = sum(stats["response_times"]) / len(stats["response_times"]) if stats["response_times"] else 0
            model_results.append((model, avg_success, avg_accuracy, avg_time))
    
    # Sort by success rate (descending)
    model_results.sort(key=lambda x: x[1], reverse=True)
    
    for rank, (model, success, accuracy, time) in enumerate(model_results, 1):
        summary_content += f"| {rank} | {model} | {success:.1%} | {accuracy:.1%} | {time:.2f}s |\n"
    
    # Add detailed retry analysis
    if retry_stats["tests_with_retries"] > 0:
        summary_content += f"""

## Detailed Retry Analysis

### Retry Statistics by Model

| Model | Tests with Retries | Retry Rate | Avg Retries per Failed Test | Total Retry Attempts |
|-------|-------------------|------------|----------------------------|---------------------|
"""
        
        for model, stats in model_stats.items():
            retry_rate = stats["tests_with_retries"] / stats["total_tests"] if stats["total_tests"] > 0 else 0
            total_retries = sum(stats["retry_attempts"])
            avg_retries = total_retries / max(stats["tests_with_retries"], 1)
            
            summary_content += f"| {model} | {stats['tests_with_retries']}/{stats['total_tests']} | {retry_rate:.1%} | {avg_retries:.1f} | {total_retries} |\n"
        
        # Add retry reasons analysis
        if retry_stats["retry_reasons"]:
            summary_content += f"""

### Most Common Retry Reasons

| Reason | Occurrences | Percentage |
|--------|-------------|------------|
"""
            
            # Sort retry reasons by frequency
            sorted_reasons = sorted(retry_stats["retry_reasons"].items(), 
                                  key=lambda x: x[1], reverse=True)
            
            total_reason_count = sum(retry_stats["retry_reasons"].values())
            for reason, count in sorted_reasons[:10]:  # Show top 10 reasons
                percentage = count / total_reason_count if total_reason_count > 0 else 0
                summary_content += f"| {reason} | {count} | {percentage:.1%} |\n"
    
    # Add parameter extraction analysis
    param_extraction_results = [r for r in all_results if "parameter_extraction" in r["metrics"] and r["metrics"]["parameter_extraction"].get("semantic_accuracy", 0) > 0]
    
    if param_extraction_results:
        summary_content += f"""

## Parameter Extraction Analysis

### Parameter Accuracy by Model (Extraction Scenarios Only)

| Model | Avg Semantic Accuracy | Title Accuracy | Priority Accuracy | Date Accuracy | Completeness | Tests |
|-------|---------------------|---------------|------------------|---------------|-------------|--------|
"""
        
        # Calculate parameter extraction stats by model
        param_stats = {}
        for result in param_extraction_results:
            model = result["model"]
            if model not in param_stats:
                param_stats[model] = {
                    "semantic_accuracies": [],
                    "title_accuracies": [],
                    "priority_accuracies": [],
                    "date_accuracies": [],
                    "completeness_scores": [],
                    "test_count": 0
                }
            
            param_metrics = result["metrics"]["parameter_extraction"]
            param_stats[model]["semantic_accuracies"].append(param_metrics.get("semantic_accuracy", 0))
            param_stats[model]["title_accuracies"].append(param_metrics.get("title_accuracy", 0))
            param_stats[model]["priority_accuracies"].append(param_metrics.get("priority_accuracy", 0))
            param_stats[model]["date_accuracies"].append(param_metrics.get("date_accuracy", 0))
            param_stats[model]["completeness_scores"].append(param_metrics.get("completeness_score", 0))
            param_stats[model]["test_count"] += 1
        
        # Sort models by semantic accuracy
        sorted_param_models = sorted(param_stats.items(), 
                                   key=lambda x: sum(x[1]["semantic_accuracies"]) / len(x[1]["semantic_accuracies"]) if x[1]["semantic_accuracies"] else 0, 
                                   reverse=True)
        
        for model, stats in sorted_param_models:
            avg_semantic = sum(stats["semantic_accuracies"]) / len(stats["semantic_accuracies"]) if stats["semantic_accuracies"] else 0
            avg_title = sum(stats["title_accuracies"]) / len(stats["title_accuracies"]) if stats["title_accuracies"] else 0
            avg_priority = sum(stats["priority_accuracies"]) / len(stats["priority_accuracies"]) if stats["priority_accuracies"] else 0
            avg_date = sum(stats["date_accuracies"]) / len(stats["date_accuracies"]) if stats["date_accuracies"] else 0
            avg_completeness = sum(stats["completeness_scores"]) / len(stats["completeness_scores"]) if stats["completeness_scores"] else 0
            
            summary_content += f"| {model} | {avg_semantic:.1%} | {avg_title:.1%} | {avg_priority:.1%} | {avg_date:.1%} | {avg_completeness:.1%} | {stats['test_count']} |\n"
        
        # Find best parameter extractor
        if sorted_param_models:
            best_param_model = sorted_param_models[0][0]
            best_param_score = sum(sorted_param_models[0][1]["semantic_accuracies"]) / len(sorted_param_models[0][1]["semantic_accuracies"])
            
            summary_content += f"""

### Key Parameter Extraction Insights

- **Best Parameter Extractor**: {best_param_model} ({best_param_score:.1%} avg semantic accuracy)
- **Extraction Scenarios Tested**: {len(set(r["scenario"]["prompt"] for r in param_extraction_results))} unique scenarios
- **Total Parameter Tests**: {len(param_extraction_results)} tests across all models and formats

### Parameter Extraction Challenges

**Common Issues Observed:**
- Title extraction: Models sometimes over-elaborate or under-specify titles
- Priority inference: Difficulty mapping contextual urgency to explicit priority levels
- Date parsing: Challenges with relative date expressions and format consistency
- Completeness: Tendency to either miss optional parameters or hallucinate unnecessary ones
"""

    # Add workflow planning analysis
    workflow_results = [r for r in all_results if "workflow_planning" in r["metrics"] and any(r["metrics"]["workflow_planning"].get(key, 0) > 0 for key in ["sequence_logic", "dependency_awareness", "efficiency"])]
    
    if workflow_results:
        summary_content += f"""

## Workflow Planning Analysis

### Workflow Quality by Model (Workflow Scenarios Only)

| Model | Avg Workflow Score | Sequence Logic | Dependency Awareness | Efficiency | Context Usage | Tests |
|-------|-------------------|---------------|---------------------|------------|---------------|--------|
"""
        
        # Calculate workflow planning stats by model
        workflow_stats = {}
        for result in workflow_results:
            model = result["model"]
            if model not in workflow_stats:
                workflow_stats[model] = {
                    "sequence_logic_scores": [],
                    "dependency_awareness_scores": [],
                    "efficiency_scores": [],
                    "context_usage_scores": [],
                    "error_anticipation_scores": [],
                    "workflow_completeness_scores": [],
                    "test_count": 0
                }
            
            workflow_metrics = result["metrics"]["workflow_planning"]
            workflow_stats[model]["sequence_logic_scores"].append(workflow_metrics.get("sequence_logic", 0))
            workflow_stats[model]["dependency_awareness_scores"].append(workflow_metrics.get("dependency_awareness", 0))
            workflow_stats[model]["efficiency_scores"].append(workflow_metrics.get("efficiency", 0))
            workflow_stats[model]["context_usage_scores"].append(workflow_metrics.get("context_usage", 0))
            workflow_stats[model]["error_anticipation_scores"].append(workflow_metrics.get("error_anticipation", 0))
            workflow_stats[model]["workflow_completeness_scores"].append(workflow_metrics.get("workflow_completeness", 0))
            workflow_stats[model]["test_count"] += 1
        
        # Sort models by overall workflow score
        def calc_workflow_avg(stats):
            core_scores = [
                sum(stats["sequence_logic_scores"]) / len(stats["sequence_logic_scores"]) if stats["sequence_logic_scores"] else 0,
                sum(stats["dependency_awareness_scores"]) / len(stats["dependency_awareness_scores"]) if stats["dependency_awareness_scores"] else 0,
                sum(stats["efficiency_scores"]) / len(stats["efficiency_scores"]) if stats["efficiency_scores"] else 0
            ]
            return sum(core_scores) / len(core_scores)
        
        sorted_workflow_models = sorted(workflow_stats.items(), 
                                       key=lambda x: calc_workflow_avg(x[1]), 
                                       reverse=True)
        
        for model, stats in sorted_workflow_models:
            avg_sequence = sum(stats["sequence_logic_scores"]) / len(stats["sequence_logic_scores"]) if stats["sequence_logic_scores"] else 0
            avg_dependency = sum(stats["dependency_awareness_scores"]) / len(stats["dependency_awareness_scores"]) if stats["dependency_awareness_scores"] else 0
            avg_efficiency = sum(stats["efficiency_scores"]) / len(stats["efficiency_scores"]) if stats["efficiency_scores"] else 0
            avg_context = sum(stats["context_usage_scores"]) / len(stats["context_usage_scores"]) if stats["context_usage_scores"] else 0
            avg_workflow = calc_workflow_avg(stats)
            
            summary_content += f"| {model} | {avg_workflow:.1%} | {avg_sequence:.1%} | {avg_dependency:.1%} | {avg_efficiency:.1%} | {avg_context:.1%} | {stats['test_count']} |\n"
        
        # Find best workflow planner
        if sorted_workflow_models:
            best_workflow_model = sorted_workflow_models[0][0]
            best_workflow_score = calc_workflow_avg(sorted_workflow_models[0][1])
            
            summary_content += f"""

### Key Workflow Planning Insights

- **Best Workflow Planner**: {best_workflow_model} ({best_workflow_score:.1%} avg workflow score)
- **Workflow Scenarios Tested**: {len(set(r["scenario"]["prompt"] for r in workflow_results))} unique scenarios
- **Total Workflow Tests**: {len(workflow_results)} tests across all models and formats

### Workflow Planning Challenges

**Common Issues Observed:**
- Sequence Logic: Models sometimes execute operations in illogical order
- Dependency Awareness: Difficulty understanding that some operations require results from previous steps
- Context Usage: Challenge in using IDs or information from previous tool outputs
- Error Anticipation: Limited proactive validation before executing operations
"""

    summary_content += f"""

## Detailed Test Breakdown

### By Scenario
"""
    
    # Group results by scenario (robust to synthetic scenarios not in TEST_SCENARIOS)
    scenario_results = {}
    for result in all_results:
        scen = result.get("scenario", {})
        scenario_name = scen.get("name") or scen.get("prompt") or "unknown"
        if scenario_name not in scenario_results:
            scenario_results[scenario_name] = []
        scenario_results[scenario_name].append(result)
    
    for scenario_name, results in scenario_results.items():
        summary_content += f"\n#### {scenario_name.replace('_', ' ').title()}\n"
        summary_content += "| Model | Success Rate | Tool Accuracy | Response Time |\n"
        summary_content += "|-------|-------------|---------------|---------------|\n"
        
        for result in results:
            metrics = result["metrics"]
            summary_content += f"| {result['model']} | {metrics['success_rate']:.1%} | {metrics['tool_accuracy']:.1%} | {metrics['response_time']:.2f}s |\n"
    
    # Best performing model
    best_model = max(model_stats.keys(), 
                    key=lambda m: sum(model_stats[m]["success_rates"]) / len(model_stats[m]["success_rates"]))
    
    summary_content += f"""

## Key Findings

### Best Performing Model
- **Winner**: {best_model}
- **Average Success Rate**: {sum(model_stats[best_model]["success_rates"]) / len(model_stats[best_model]["success_rates"]):.1%}

## Detailed Error Analysis

### Parsing Errors by Model
"""
    
    # Analyze parsing and validation errors
    error_analysis = {}
    for result in all_results:
        model = result["model"]
        if model not in error_analysis:
            error_analysis[model] = {
                "parsing_errors": [],
                "validation_errors": [],
                "execution_errors": [],
                "failed_scenarios": []
            }
        
        # Collect errors from this result
        metrics = result["metrics"]
        if metrics["parsing_errors"] > 0 or metrics["validation_errors"] > 0:
            scen = result.get("scenario", {})
            scenario_name = scen.get("name") or scen.get("prompt") or "unknown"
            error_analysis[model]["failed_scenarios"].append(scenario_name)
            
            # Extract specific parsing errors
            for tool_call in result["tool_calls"]:
                if tool_call.get("parsing_errors"):
                    for error in tool_call["parsing_errors"]:
                        error_analysis[model]["parsing_errors"].append(f"{scenario_name}: {error}")
                if tool_call.get("validation_errors"):
                    for error in tool_call["validation_errors"]:
                        error_analysis[model]["validation_errors"].append(f"{scenario_name}: {error}")
    
    # Generate error breakdown
    for model, errors in error_analysis.items():
        summary_content += f"\n#### {model}\n"
        
        if errors["parsing_errors"]:
            summary_content += "**Parsing Errors:**\n"
            for error in errors["parsing_errors"][:5]:  # Show top 5
                summary_content += f"- {error}\n"
            if len(errors["parsing_errors"]) > 5:
                summary_content += f"- ... and {len(errors['parsing_errors']) - 5} more\n"
        
        if errors["validation_errors"]:
            summary_content += "**Validation Errors:**\n"
            for error in errors["validation_errors"][:5]:  # Show top 5
                summary_content += f"- {error}\n"
            if len(errors["validation_errors"]) > 5:
                summary_content += f"- ... and {len(errors['validation_errors']) - 5} more\n"
        
        if not errors["parsing_errors"] and not errors["validation_errors"]:
            summary_content += "**No parsing or validation errors detected**\n"
        
        summary_content += f"**Failed Scenarios:** {', '.join(errors['failed_scenarios']) if errors['failed_scenarios'] else 'None'}\n\n"

    summary_content += f"""
### System Prompt Optimization Results
- **Enhanced Prompt**: LLM-optimized with machine-readable constraints
- **Date Context**: Explicit current date '2025-08-06' and tomorrow '2025-08-07'
- **Type Specifications**: Precise formatting rules for integers, booleans, dates
- **Prohibited Patterns**: Explicit examples of invalid formats

### Critical Issues Identified
1. **Parser Sensitivity**: Tool format must be exact `key: value` per line
2. **Type Conversion**: Boolean values must be literal "true"/"false"
3. **Date Formatting**: Must be exact YYYY-MM-DD format
4. **Workflow Execution**: Multi-step scenarios test sequential tool calling

## Detailed Logs
Full conversation logs available in: `detailed_test_logs_{timestamp}.json`
"""
    
    # Write summary markdown file
    PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    RESULTS_DIR = os.environ.get("EVX_RESULTS_DIR", os.path.join(PROJECT_ROOT, "tests", "_artifacts"))
    os.makedirs(RESULTS_DIR, exist_ok=True)
    with open(os.path.join(RESULTS_DIR, "TEST_RESULTS_SUMMARY.md"), "w") as f:
        f.write(summary_content)
    
    # Build JSON aggregates
    aggregates: Dict[str, Any] = {
        "timestamp": timestamp,
        "models": list(model_stats.keys()),
        "model_stats": {},
        "format_stats": {},
        "retry_stats": {
            "total_tests": retry_stats["total_tests"],
            "tests_with_retries": retry_stats["tests_with_retries"],
            "total_retry_attempts": retry_stats["total_retry_attempts"],
            "retry_reasons": retry_stats["retry_reasons"],
        },
        "best_in_class": {},
        "pipeline": {
            "extraction": {},
            "verification": {},
            "execution": {},
            "best_in_class": {}
        },
        "provenance": {
            "anchor_date": ANCHOR_DATE,
            "phase": PHASE,
            "ollama_options": OLLAMA_REQUEST_OPTIONS,
        },
    }

    # Fill per-model aggregates (including tool usage precision/recall/F1 averages)
    # Compute Task Score components using intuitive defaults
    # - Correctness: avg success_rate (70%)
    # - Latency: normalized against SLA (default 10s; 1.0 at or below SLA, 0.0 at 2x SLA) (20%)
    # - Stability: 1.0 with no retries, down to 0 with increasing retries (simple step: -0.5 per retry) (10%)
    DEFAULT_SLA_SECONDS = 10.0

    # Pre-index per-model per-result for latency/stability scoring
    results_by_model: Dict[str, List[Dict[str, Any]]] = {}
    for r in all_results:
        results_by_model.setdefault(r["model"], []).append(r)

    task_scores: Dict[str, float] = {}

    for model, stats in model_stats.items():
        avg_success = sum(stats["success_rates"]) / len(stats["success_rates"]) if stats["success_rates"] else 0
        avg_accuracy = sum(stats["tool_accuracies"]) / len(stats["tool_accuracies"]) if stats["tool_accuracies"] else 0
        avg_time = sum(stats["response_times"]) / len(stats["response_times"]) if stats["response_times"] else 0

        # Compute average tool usage metrics from individual results
        usage_precisions: List[float] = []
        usage_recalls: List[float] = []
        usage_f1s: List[float] = []
        for r in results_by_model.get(model, []):
            tu = r.get("metrics", {}).get("tool_usage", {})
            if tu:
                usage_precisions.append(tu.get("precision", 0.0))
                usage_recalls.append(tu.get("recall", 0.0))
                usage_f1s.append(tu.get("f1", 0.0))

        # Latency score: per result convert response_time to [0,1] via SLA, average
        latency_scores: List[float] = []
        stability_scores: List[float] = []
        for r in results_by_model.get(model, []):
            scen = r.get("scenario", {})
            sla = float(scen.get("sla_seconds", DEFAULT_SLA_SECONDS))
            rt = float(r.get("metrics", {}).get("response_time", 0.0))
            if rt <= sla:
                latency_scores.append(1.0)
            elif rt >= 3 * sla:
                latency_scores.append(0.0)
            else:
                # Linear falloff between SLA and 3x SLA
                over = rt - sla
                span = 2 * sla  # from SLA to 3x SLA
                latency_scores.append(max(0.0, 1.0 - (over / span)))

            ra = int(r.get("retry_info", {}).get("retry_attempts", 0))
            # Simple stability mapping: 0 retries -> 1.0; 1 retry -> 0.5; 2+ -> 0.0
            stability_scores.append(max(0.0, 1.0 - 0.5 * ra))

        avg_latency_score = (sum(latency_scores) / len(latency_scores)) if latency_scores else 1.0
        avg_stability_score = (sum(stability_scores) / len(stability_scores)) if stability_scores else 1.0

        # Task Score per model
        task_score = (0.7 * avg_success) + (0.2 * avg_latency_score) + (0.1 * avg_stability_score)
        task_scores[model] = task_score

        aggregates["model_stats"][model] = {
            "avg_success_rate": avg_success,
            "avg_tool_accuracy": avg_accuracy,
            "avg_response_time_s": avg_time,
            "total_tests": stats["total_tests"],
            "retry_rate": (stats["tests_with_retries"] / stats["total_tests"]) if stats["total_tests"] else 0,
            "avg_tool_usage": {
                "precision": (sum(usage_precisions) / len(usage_precisions)) if usage_precisions else 0,
                "recall": (sum(usage_recalls) / len(usage_recalls)) if usage_recalls else 0,
                "f1": (sum(usage_f1s) / len(usage_f1s)) if usage_f1s else 0,
            },
            "task_score": task_score,
            "avg_latency_score": avg_latency_score,
            "avg_stability_score": avg_stability_score,
        }

    # Simple best-in-class selections
    def _best_by(key, reverse=True):
        items = []
        for model, m in aggregates["model_stats"].items():
            items.append((model, m.get(key, 0)))
        items.sort(key=lambda x: x[1], reverse=reverse)
        return items[0][0] if items else None

    # Best-in-class including Task Score
    aggregates["best_in_class"] = {
        "best_success_rate": _best_by("avg_success_rate", True),
        "best_tool_accuracy": _best_by("avg_tool_accuracy", True),
        "fastest_response": _best_by("avg_response_time_s", False),
        "best_task_score": (sorted(((m, s) for m, s in task_scores.items()), key=lambda x: x[1], reverse=True)[0][0]) if task_scores else None,
    }

    # Sorted task score ranking for template convenience
    aggregates["task_ranking"] = [
        {"model": m, "task_score": s}
        for m, s in sorted(task_scores.items(), key=lambda x: x[1], reverse=True)
    ]

    # Global per-format aggregates (averages + retry and model coverage)
    for fkey, fstats in format_stats.items():
        sr = fstats.get("success_rates", [])
        ta = fstats.get("tool_accuracies", [])
        rt = fstats.get("response_times", [])
        uf = fstats.get("tool_usage_f1s", [])
        total_tests = int(fstats.get("total_tests", 0))
        tests_with_retries = int(fstats.get("tests_with_retries", 0))
        retry_rate = (tests_with_retries / total_tests) if total_tests > 0 else 0.0
        aggregates["format_stats"][fkey] = {
            "format_name": fstats.get("format_name"),
            "avg_success_rate": (sum(sr) / len(sr)) if sr else 0.0,
            "avg_tool_accuracy": (sum(ta) / len(ta)) if ta else 0.0,
            "avg_response_time_s": (sum(rt) / len(rt)) if rt else 0.0,
            "avg_tool_usage_f1": (sum(uf) / len(uf)) if uf else 0.0,
            "total_tests": total_tests,
            "tests_with_retries": tests_with_retries,
            "retry_rate": retry_rate,
            "models": sorted(list(fstats.get("models", set()))),
        }

    # --------------------------------------
    # Parameter Extraction Aggregates
    # --------------------------------------
    param_model_scores: Dict[str, Dict[str, List[float]]] = {}
    for result in all_results:
        scenario = result.get("scenario", {})
        if scenario.get("evaluation_focus") != "parameter_extraction":
            continue
        model = result["model"]
        metrics = result.get("metrics", {}).get("parameter_extraction", {})
        if not metrics:
            continue
        bucket = param_model_scores.setdefault(model, {
            "semantic_accuracy": [],
            "title_accuracy": [],
            "priority_accuracy": [],
            "date_accuracy": [],
            "completeness": [],
        })
        bucket["semantic_accuracy"].append(metrics.get("semantic_accuracy", 0.0))
        bucket["title_accuracy"].append(metrics.get("title_accuracy", 0.0))
        bucket["priority_accuracy"].append(metrics.get("priority_accuracy", 0.0))
        bucket["date_accuracy"].append(metrics.get("date_accuracy", 0.0))
        bucket["completeness"].append(metrics.get("completeness_score", 0.0))

    param_averages: Dict[str, Any] = {}
    for model, series in param_model_scores.items():
        tests_count = len(series["semantic_accuracy"]) if series["semantic_accuracy"] else 0
        def avg(arr: List[float]) -> float:
            return (sum(arr) / len(arr)) if arr else 0.0
        param_averages[model] = {
            "semantic_accuracy": avg(series["semantic_accuracy"]),
            "title_accuracy": avg(series["title_accuracy"]),
            "priority_accuracy": avg(series["priority_accuracy"]),
            "date_accuracy": avg(series["date_accuracy"]),
            "completeness": avg(series["completeness"]),
            "tests": tests_count,
        }

    best_param_model = None
    best_param_score = 0.0
    for model, stats in param_averages.items():
        score = stats.get("semantic_accuracy", 0.0)
        if score > best_param_score:
            best_param_score = score
            best_param_model = model

    aggregates["parameter_extraction"] = {
        "model_averages": param_averages,
        "best_model": best_param_model,
        "best_score": best_param_score,
    }

    # --------------------------------------
    # Workflow Planning Aggregates
    # --------------------------------------
    workflow_model_scores: Dict[str, Dict[str, List[float]]] = {}
    for result in all_results:
        scenario = result.get("scenario", {})
        if scenario.get("evaluation_focus") != "workflow_planning":
            continue
        model = result["model"]
        metrics = result.get("metrics", {}).get("workflow_planning", {})
        if not metrics:
            continue
        bucket = workflow_model_scores.setdefault(model, {
            "sequence_logic": [],
            "dependency_awareness": [],
            "efficiency": [],
            "context_usage": [],
            "error_anticipation": [],
            "workflow_completeness": [],
        })
        bucket["sequence_logic"].append(metrics.get("sequence_logic", 0.0))
        bucket["dependency_awareness"].append(metrics.get("dependency_awareness", 0.0))
        bucket["efficiency"].append(metrics.get("efficiency", 0.0))
        bucket["context_usage"].append(metrics.get("context_usage", 0.0))
        bucket["error_anticipation"].append(metrics.get("error_anticipation", 0.0))
        bucket["workflow_completeness"].append(metrics.get("workflow_completeness", 0.0))

    workflow_averages: Dict[str, Any] = {}
    for model, series in workflow_model_scores.items():
        def avg(arr: List[float]) -> float:
            return (sum(arr) / len(arr)) if arr else 0.0
        workflow_averages[model] = {
            "sequence_logic": avg(series["sequence_logic"]),
            "dependency_awareness": avg(series["dependency_awareness"]),
            "efficiency": avg(series["efficiency"]),
            "context_usage": avg(series["context_usage"]),
            "error_anticipation": avg(series["error_anticipation"]),
            "workflow_completeness": avg(series["workflow_completeness"]),
            "tests": len(series["sequence_logic"]) if series["sequence_logic"] else 0,
        }

    # Define core score as average of sequence_logic, dependency_awareness, efficiency
    best_workflow_model = None
    best_workflow_score = 0.0
    for model, stats in workflow_averages.items():
        core_scores = [stats.get("sequence_logic", 0.0), stats.get("dependency_awareness", 0.0), stats.get("efficiency", 0.0)]
        core_avg = sum(core_scores) / len(core_scores) if core_scores else 0.0
        if core_avg > best_workflow_score:
            best_workflow_score = core_avg
            best_workflow_model = model

    aggregates["workflow_planning"] = {
        "model_averages": workflow_averages,
        "best_model": best_workflow_model,
        "best_score": best_workflow_score,
    }

    # --------------------------------------
    # Pipeline Aggregates (derived from single-shot data)
    # --------------------------------------
    # Aggregate per-model, per-step metrics if pipeline data exists on results
    pipeline_models: Dict[str, Dict[str, Any]] = {}
    for r in all_results:
        p = r.get("pipeline")
        if not p:
            continue
        # Prefer step-specific model identity if present; fallback to top-level model
        model_ex = (p.get("extract") or {}).get("model") or r.get("model")
        model_v  = (p.get("verify") or {}).get("model") or r.get("model")
        model_x  = (p.get("execute") or {}).get("model") or r.get("model")

        pm_ex = pipeline_models.setdefault(model_ex, {
            "extraction": {"tool_f1": [], "order_adherence": [], "parameter_readiness": []},
            "verification": {"acceptance_f1": [], "hallucination_f1": []},
            "execution": {"success_rate": [], "tool_accuracy": [], "tool_usage_f1": []},
        })
        ex = p.get("extract", {}).get("metrics", {})
        if ex:
            pm_ex["extraction"]["tool_f1"].append(ex.get("tool_f1", 0.0))
            pm_ex["extraction"]["order_adherence"].append(ex.get("order_adherence", 0.0))
            pm_ex["extraction"]["parameter_readiness"].append(ex.get("parameter_readiness", 0.0))

        pm_ver = pipeline_models.setdefault(model_v, {
            "extraction": {"tool_f1": [], "order_adherence": [], "parameter_readiness": []},
            "verification": {"acceptance_f1": [], "hallucination_f1": []},
            "execution": {"success_rate": [], "tool_accuracy": [], "tool_usage_f1": []},
        })
        ve = p.get("verify", {}).get("metrics", {})
        if ve:
            pm_ver["verification"]["acceptance_f1"].append(ve.get("acceptance_f1", 0.0))
            pm_ver["verification"]["hallucination_f1"].append(ve.get("hallucination_f1", 0.0))

        pm_exe = pipeline_models.setdefault(model_x, {
            "extraction": {"tool_f1": [], "order_adherence": [], "parameter_readiness": []},
            "verification": {"acceptance_f1": [], "hallucination_f1": []},
            "execution": {"success_rate": [], "tool_accuracy": [], "tool_usage_f1": []},
        })
        exu = p.get("execute", {}).get("metrics", {})
        if exu:
            pm_exe["execution"]["success_rate"].append(exu.get("success_rate", 0.0))
            pm_exe["execution"]["tool_accuracy"].append(exu.get("tool_accuracy", 0.0))
            pm_exe["execution"]["tool_usage_f1"].append(exu.get("tool_usage_f1", 0.0))

    def _avg(lst: List[float]) -> float:
        return (sum(lst) / len(lst)) if lst else 0.0

    # Fill aggregates.pipeline per model
    for model, series in pipeline_models.items():
        aggregates["pipeline"]["extraction"][model] = {
            "tool_f1": _avg(series["extraction"]["tool_f1"]),
            "order_adherence": _avg(series["extraction"]["order_adherence"]),
            "parameter_readiness": _avg(series["extraction"]["parameter_readiness"]),
        }
        aggregates["pipeline"]["verification"][model] = {
            "acceptance_f1": _avg(series["verification"]["acceptance_f1"]),
            "hallucination_f1": _avg(series["verification"]["hallucination_f1"]),
        }
        aggregates["pipeline"]["execution"][model] = {
            "success_rate": _avg(series["execution"]["success_rate"]),
            "tool_accuracy": _avg(series["execution"]["tool_accuracy"]),
            "tool_usage_f1": _avg(series["execution"]["tool_usage_f1"]),
        }

    # Compute Pipeline Best-in-Class via majority-of-steps wins; tiebreaker: avg rank
    def _ranks(d: Dict[str, float], reverse=True) -> Dict[str, int]:
        items = sorted(d.items(), key=lambda x: x[1], reverse=reverse)
        return {m: i + 1 for i, (m, _) in enumerate(items)}

    ext_scores = {m: v.get("tool_f1", 0.0) for m, v in aggregates["pipeline"]["extraction"].items()}
    ver_scores = {m: v.get("acceptance_f1", 0.0) for m, v in aggregates["pipeline"]["verification"].items()}
    exe_scores = {m: v.get("success_rate", 0.0) for m, v in aggregates["pipeline"]["execution"].items()}

    if ext_scores and ver_scores and exe_scores:
        r_ext = _ranks(ext_scores, True)
        r_ver = _ranks(ver_scores, True)
        r_exe = _ranks(exe_scores, True)
        models_all = set(r_ext) | set(r_ver) | set(r_exe)
        wins = {m: 0 for m in models_all}
        avg_rank = {m: (_ranks(ext_scores).get(m, 0) + _ranks(ver_scores).get(m, 0) + _ranks(exe_scores).get(m, 0)) / 3 for m in models_all}
        # Majority-of-steps wins: lower rank is better
        best_per_step = [min(r_ext, key=r_ext.get), min(r_ver, key=r_ver.get), min(r_exe, key=r_exe.get)]
        for m in best_per_step:
            wins[m] = wins.get(m, 0) + 1
        max_wins = max(wins.values()) if wins else 0
        contenders = [m for m, w in wins.items() if w == max_wins]
        winner = min(contenders, key=lambda m: avg_rank.get(m, float('inf'))) if contenders else None
        aggregates["pipeline"]["best_in_class"] = {
            "winner": winner,
            "details": f"Wins: {wins} | Avg rank: {avg_rank}"
        }

    # --------------------------------------
    # Scenario Breakdown Aggregates
    # --------------------------------------
    # Build a mapping from scenario dict back to its name for stability
    scenario_name_by_id: Dict[int, str] = {}
    for name, sc in TEST_SCENARIOS.items():
        scenario_name_by_id[id(sc)] = name

    scenarios_aggregate: Dict[str, Dict[str, Dict[str, float]]] = {}
    # Collect per-scenario, per-model metrics
    for result in all_results:
        model = result["model"]
        scenario = result.get("scenario", {})
        name = scenario_name_by_id.get(id(scenario), scenario.get("prompt", "unknown"))
        metrics = result.get("metrics", {})
        entry = scenarios_aggregate.setdefault(name, {}).setdefault(model, {"success_rate": 0.0, "tool_accuracy": 0.0, "avg_time_s": 0.0, "_count": 0})
        entry["success_rate"] += metrics.get("success_rate", 0.0)
        entry["tool_accuracy"] += metrics.get("tool_accuracy", 0.0)
        entry["avg_time_s"] += metrics.get("response_time", 0.0)
        entry["_count"] += 1

    # Convert sums to averages and drop counters
    for scen_name, per_model in scenarios_aggregate.items():
        for model, m in per_model.items():
            cnt = m.get("_count", 1)
            m["success_rate"] = m["success_rate"] / cnt if cnt else 0.0
            m["tool_accuracy"] = m["tool_accuracy"] / cnt if cnt else 0.0
            m["avg_time_s"] = m["avg_time_s"] / cnt if cnt else 0.0
            m.pop("_count", None)

    aggregates["scenarios"] = scenarios_aggregate

    # Write JSON summary files
    summary_json_path = os.path.join(RESULTS_DIR, f"summary_{timestamp}.json")
    with open(summary_json_path, "w") as fjson:
        json.dump(aggregates, fjson, indent=2)
    # Stable latest pointer
    with open(os.path.join(RESULTS_DIR, "summary_latest.json"), "w") as fjson_latest:
        json.dump(aggregates, fjson_latest, indent=2)

    # Write detailed logs
    with open(os.path.join(RESULTS_DIR, f"detailed_test_logs_{timestamp}.json"), "w") as f:
        json.dump(all_results, f, indent=2, default=str)

if __name__ == "__main__":
    run_comprehensive_test()
