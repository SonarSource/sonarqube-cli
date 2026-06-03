#!/usr/bin/env bash

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${NIGHT_OWL_CANDIDATE_JQL:?NIGHT_OWL_CANDIDATE_JQL is required}"
: "${NIGHT_OWL_JIRA_LABEL:?NIGHT_OWL_JIRA_LABEL is required}"
: "${NIGHT_OWL_JIRA_PROJECT:?NIGHT_OWL_JIRA_PROJECT is required}"
: "${NIGHT_OWL_JIRA_SITE:?NIGHT_OWL_JIRA_SITE is required}"

emit_output() {
  printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
}

emit_multiline_output() {
  local name="$1"
  local value="$2"
  local delimiter="EOF_$(openssl rand -hex 12)"

  {
    printf '%s<<%s\n' "$name" "$delimiter"
    printf '%s\n' "$value"
    printf '%s\n' "$delimiter"
  } >>"$GITHUB_OUTPUT"
}

normalize_collection() {
  jq -c '
    if type == "array" then .
    elif .issues? then .issues
    elif .values? then .values
    elif .results? then .results
    elif .items? then .items
    elif .comments? then .comments
    else []
    end
  '
}

normalize_single() {
  jq -c '
    if type == "array" then .[0]
    elif .issues? then .issues[0]
    elif .values? then .values[0]
    elif .results? then .results[0]
    elif .items? then .items[0]
    else .
    end
  '
}

adf_to_text() {
  jq -r '
    def textify:
      if . == null then ""
      elif type == "string" then .
      elif type == "array" then
        map(textify)
        | map(select(length > 0))
        | join("\n")
      elif type == "object" then
        ([.text? // empty, (.content? | textify)] | map(select(length > 0)) | join("\n"))
      else
        tostring
      end;
    textify | gsub("\r"; "")
  '
}

compact_text() {
  printf '%s' "$1" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

truncate_text() {
  local text
  local limit

  text="$(compact_text "$1")"
  limit="${2:-400}"

  if [ "${#text}" -le "$limit" ]; then
    printf '%s' "$text"
    return
  fi

  printf '%s…' "${text:0:$((limit - 1))}"
}

issue_key() {
  jq -r '.key // .issueKey // empty'
}

issue_summary() {
  jq -r '.fields.summary // .summary // empty'
}

issue_status() {
  jq -r '.fields.status.name // .status.name // .status // empty'
}

issue_type() {
  jq -r '.fields.issuetype.name // .issuetype.name // .issueType.name // empty'
}

issue_project() {
  jq -r '.fields.project.key // .project.key // empty'
}

issue_parent_key() {
  jq -r '.fields.parent.key // .parent.key // empty'
}

issue_labels_csv() {
  jq -r '[.fields.labels[]?, .labels[]?] | unique | join(", ")'
}

issue_has_label() {
  local label="$1"
  jq -e --arg label "$label" '[.fields.labels[]?, .labels[]?] | index($label) != null' >/dev/null
}

issue_description_text() {
  local issue_json="$1"
  local description_text

  description_text="$(
    jq '.fields.description // .description // null' <<<"$issue_json" | adf_to_text
  )"

  if [ -n "$(compact_text "$description_text")" ]; then
    printf '%s\n' "$description_text"
  else
    printf '_None provided._\n'
  fi
}

has_open_pr_for_key() {
  local key="$1"
  local pattern="(^|[^A-Z0-9])${key}([^A-Z0-9]|$)"

  jq -e --arg pattern "$pattern" '
    any(
      .[]?;
      ([.title // "", .body // "", .headRefName // ""] | join("\n")) | test($pattern; "i")
    )
  ' <<<"$OPEN_PULL_REQUESTS_JSON" >/dev/null
}

format_comments_markdown() {
  local comments_json="$1"
  local result=''
  local comment=''

  while IFS= read -r comment; do
    local author=""
    local created=""
    local body=""
    local body_text=""
    local excerpt=""

    author="$(jq -r '.author.displayName // .author.name // "unknown author"' <<<"$comment")"
    created="$(jq -r '.updated // .created // "unknown date"' <<<"$comment")"
    body="$(jq '.body // .comment // .text // null' <<<"$comment")"
    body_text="$(adf_to_text <<<"$body")"
    excerpt="$(truncate_text "$body_text" 400)"

    if [ -z "$excerpt" ]; then
      excerpt='(no comment body)'
    fi

    result+="- ${author} (${created}): ${excerpt}"$'\n'
  done < <(normalize_collection <<<"$comments_json" | jq -c '.[]?')

  if [ -z "$result" ]; then
    printf '_No comments loaded._\n'
  else
    printf '%s' "$result"
  fi
}

format_links_markdown() {
  local links_json="$1"
  local result=''
  local link=''

  while IFS= read -r link; do
    local relationship=""
    local linked_key=""
    local linked_status=""
    local linked_summary=""
    local line=""

    relationship="$(jq -r '.type.name // .linkType.name // .name // "linked"' <<<"$link")"
    linked_key="$(jq -r '.outwardIssue.key // .inwardIssue.key // .workItem.key // .linkedWorkItem.key // .issue.key // .key // empty' <<<"$link")"
    linked_status="$(jq -r '.outwardIssue.fields.status.name // .outwardIssue.status.name // .outwardIssue.status // .inwardIssue.fields.status.name // .inwardIssue.status.name // .inwardIssue.status // .workItem.fields.status.name // .workItem.status.name // .workItem.status // empty' <<<"$link")"
    linked_summary="$(jq -r '.outwardIssue.fields.summary // .outwardIssue.summary // .inwardIssue.fields.summary // .inwardIssue.summary // .workItem.fields.summary // .workItem.summary // .linkedWorkItem.fields.summary // .linkedWorkItem.summary // .issue.fields.summary // .issue.summary // empty' <<<"$link")"

    line="- ${relationship}"
    if [ -n "$linked_key" ]; then
      line+=" ${linked_key}"
    fi
    if [ -n "$linked_status" ]; then
      line+=" (${linked_status})"
    fi
    if [ -n "$linked_summary" ]; then
      line+=": ${linked_summary}"
    fi

    result+="${line}"$'\n'
  done < <(normalize_collection <<<"$links_json" | jq -c '.[]?')

  if [ -z "$result" ]; then
    printf '_No direct issue links loaded._\n'
  else
    printf '%s' "$result"
  fi
}

set_starving_outputs() {
  local outcome="$1"

  emit_output prep_status starving
  emit_output issue_key ""
  emit_output issue_url ""
  emit_output issue_summary ""
  emit_output parent_key ""
  emit_output parent_url ""
  emit_output parent_summary ""
  emit_multiline_output context_markdown ""
  emit_multiline_output slack_message "$outcome"
}

search_workitems() {
  if acli jira workitem search --jql "$NIGHT_OWL_CANDIDATE_JQL" --paginate --json 2>/dev/null; then
    return
  fi

  acli jira workitem search --jql "$NIGHT_OWL_CANDIDATE_JQL" --limit 50 --json
}

view_workitem() {
  local key="$1"
  local fields="${2:-*all}"

  if acli jira workitem view "$key" --fields "$fields" --json 2>/dev/null; then
    return
  fi

  acli jira workitem view --key "$key" --fields "$fields" --json
}

list_comments() {
  local key="$1"

  if acli jira workitem comment list --key "$key" --order -updated --limit 10 --json 2>/dev/null; then
    return
  fi

  acli jira workitem comment list "$key" --order -updated --limit 10 --json
}

list_links() {
  local key="$1"

  if acli jira workitem link list --key "$key" --json 2>/dev/null; then
    return
  fi

  acli jira workitem link list "$key" --json
}

OPEN_PULL_REQUESTS_JSON="$(
  gh pr list \
    --repo "$GITHUB_REPOSITORY" \
    --state open \
    --limit 100 \
    --json number,title,body,headRefName,url
)"

SEARCH_RESULTS_JSON="$(search_workitems)"

selected_issue_json=''
selected_issue_key=''
skipped_in_flight=0
candidate_count=0

while IFS= read -r candidate; do
  current_key="$(issue_key <<<"$candidate")"
  current_status="$(issue_status <<<"$candidate")"

  if [ -z "$current_key" ]; then
    continue
  fi

  candidate_count=$((candidate_count + 1))

  case "$current_status" in
    Open|TODO|"To Do") ;;
    *)
      continue
      ;;
  esac

  if has_open_pr_for_key "$current_key"; then
    skipped_in_flight=$((skipped_in_flight + 1))
    continue
  fi

  full_issue_json_raw="$(view_workitem "$current_key" "*all")"
  full_issue_json="$(normalize_single <<<"$full_issue_json_raw")"

  if [ "$(issue_project <<<"$full_issue_json")" != "$NIGHT_OWL_JIRA_PROJECT" ]; then
    continue
  fi

  if ! issue_has_label "$NIGHT_OWL_JIRA_LABEL" <<<"$full_issue_json"; then
    continue
  fi

  case "$(issue_status <<<"$full_issue_json")" in
    Open|TODO|"To Do") ;;
    *)
      continue
      ;;
  esac

  selected_issue_key="$current_key"
  selected_issue_json="$full_issue_json"
  break
done < <(normalize_collection <<<"$SEARCH_RESULTS_JSON" | jq -c '.[]?')

if [ -z "$selected_issue_key" ]; then
  if [ "$candidate_count" -eq 0 ]; then
    set_starving_outputs "Night Owl: :sleeping: starving
Outcome: No Jira ticket matched the Night Owl query for project ${NIGHT_OWL_JIRA_PROJECT}, label ${NIGHT_OWL_JIRA_LABEL}, and statuses Open/TODO/To Do.
Action needed: Add a qualifying Jira ticket for the agent."
  else
    set_starving_outputs "Night Owl: :sleeping: starving
Outcome: No Jira ticket remained after skipping tickets already covered by an open pull request and revalidating the Night Owl filters.
Context: ${skipped_in_flight} matching ticket(s) were already in flight.
Action needed: Add another qualifying Jira ticket or finish the open PRs already covering the current queue."
  fi
  exit 0
fi

selected_issue_summary="$(issue_summary <<<"$selected_issue_json")"
selected_issue_status="$(issue_status <<<"$selected_issue_json")"
selected_issue_type="$(issue_type <<<"$selected_issue_json")"
selected_issue_labels="$(issue_labels_csv <<<"$selected_issue_json")"
selected_issue_url="https://${NIGHT_OWL_JIRA_SITE}/browse/${selected_issue_key}"

parent_key="$(issue_parent_key <<<"$selected_issue_json")"
parent_json=''
parent_summary=''
parent_url=''

if [ -n "$parent_key" ]; then
  parent_json_raw="$(view_workitem "$parent_key" "*all")"
  parent_json="$(normalize_single <<<"$parent_json_raw")"
  parent_summary="$(issue_summary <<<"$parent_json")"
  parent_url="https://${NIGHT_OWL_JIRA_SITE}/browse/${parent_key}"
fi

comments_json='[]'
comments_note=''
if ! comments_json="$(list_comments "$selected_issue_key")"; then
  comments_json='[]'
  comments_note='_Comments could not be loaded by the prep job._'
fi

links_json='[]'
links_note=''
if ! links_json="$(list_links "$selected_issue_key")"; then
  links_json='[]'
  links_note='_Direct issue links could not be loaded by the prep job._'
fi

selected_issue_description="$(issue_description_text "$selected_issue_json")"
parent_description='_No parent ticket._'
if [ -n "$parent_json" ]; then
  parent_description="$(issue_description_text "$parent_json")"
fi

comments_section="$(format_comments_markdown "$comments_json")"
links_section="$(format_links_markdown "$links_json")"

context_markdown="$(
  cat <<EOF
# Prepared Jira Context

## Selection

- Candidate JQL: \`${NIGHT_OWL_CANDIDATE_JQL}\`
- Selected ticket: [${selected_issue_key}](https://${NIGHT_OWL_JIRA_SITE}/browse/${selected_issue_key})
- Status: ${selected_issue_status}
- Type: ${selected_issue_type}
- Labels: ${selected_issue_labels}
- Selection rule: first eligible ticket after Jira filtering and open PR deduplication

## Ticket Summary

- Key: ${selected_issue_key}
- URL: ${selected_issue_url}
- Summary: ${selected_issue_summary}

## Ticket Description

${selected_issue_description}

## Parent Context

EOF
)"

if [ -n "$parent_key" ]; then
  context_markdown+="$(
    cat <<EOF
- Key: ${parent_key}
- URL: ${parent_url}
- Summary: ${parent_summary}

### Parent Description

${parent_description}

EOF
  )"
else
  context_markdown+="_No parent ticket._"$'\n\n'
fi

context_markdown+="$(
  cat <<EOF
## Recent Comments

${comments_note}
${comments_section}

## Direct Issue Links

${links_note}
${links_section}
EOF
)"

emit_output prep_status ready
emit_output issue_key "$selected_issue_key"
emit_output issue_url "$selected_issue_url"
emit_output issue_summary "$selected_issue_summary"
emit_output parent_key "$parent_key"
emit_output parent_url "$parent_url"
emit_output parent_summary "$parent_summary"
emit_multiline_output context_markdown "$context_markdown"
emit_multiline_output slack_message ""
