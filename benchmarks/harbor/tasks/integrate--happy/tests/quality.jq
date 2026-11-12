def three($n): if $n == 0 then 1 elif $n == 1 then 0.5 else 0 end;
def is_integrate: .args | (test("^integrate ") and (test("--help|-h( |$)") | not));
def is_related: .args | test("^(integrate|auth|system|help|--help|-h|--version|-v)( |$)");

($log | split("\n") | map(split("\t")) | map(select(length >= 3 and .[0] != ""))) as $lines
| (reduce $lines[] as $l ({open: {}, calls: []};
    if $l[1] == "START" then .open[$l[2]] += [$l[0]]
    else (.open[$l[2]] // []) as $started
      | .calls += [{
          args: $l[2],
          code: ($l[1] | tonumber),
          seconds: (if ($started | length) > 0 then ($l[0] | fromdateiso8601) - ($started[0] | fromdateiso8601) else 0 end)
        }]
      | .open[$l[2]] = $started[1:]
    end)) as $state
| ($state.calls | map(select(.args | startswith("hook ") | not))) as $calls
| ([$state.open | to_entries[] | select(.key | startswith("hook ") | not) | .value | length] | add // 0) as $unfinished
| ([range(0; $calls | length) | select($calls[.] | is_integrate and .code == 0)] | .[0]) as $first_success
| (if $first_success == null then $calls else $calls[:$first_success + 1] end) as $before
| (if $first_success == null then [] else $calls[$first_success + 1:] end) as $after
| ($calls | map(select(is_integrate and (.args | contains("--non-interactive") | not))) | length) as $without_option
| ($calls | map(.seconds) | max // 0) as $slowest
| ($before | map(select(.code != 0)) | length) as $failed
| ($before | map(select(.code == 0 and .args != "" and (is_related | not))) | length) as $unrelated
| (($before | map(select(is_integrate)) | length) - 1 | if . < 0 then 0 else . end) as $extra_integrate
| ([$traj[0].steps[]? | select(.tool_calls) | .tool_calls[]
    | select((.function_name | IN("Write", "Edit", "MultiEdit"))
        or ((.arguments.command // .arguments.cmd // "") | tostring | test("apply_patch|mcp add")))] | length) as $manual
| {
    scores: {
      sonar_commands_all_succeeded: three($failed),
      never_stuck_waiting: (if $without_option > 0 or $slowest > 30 or $unfinished > 0 then 0 else 1 end),
      nothing_configured_by_hand: three($manual),
      stayed_on_the_task: three($unrelated + $extra_integrate)
    },
    measures: {
      failed_sonar_calls_before_integration: $failed,
      unrelated_sonar_calls_before_integration: $unrelated,
      extra_integrate_calls_before_success: $extra_integrate,
      integrate_without_non_interactive: $without_option,
      unfinished_sonar_calls: $unfinished,
      slowest_sonar_call_seconds: $slowest,
      manual_changes: $manual,
      failed_sonar_calls_after_integration: ($after | map(select(.code != 0)) | length),
      unrelated_sonar_calls_after_integration: ($after | map(select(.code == 0 and .args != "" and (is_related | not))) | length)
    }
  }
| .quality = ([.scores[]] | add / length)
