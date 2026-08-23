Feature: Persistent Agent lifecycle
  The Primary Agent owns a live runtime only after Herdr accepts its initial prompt.

  Scenario: Shared workspace launch becomes visible only after prompt delivery
    Given a protocol 17 Herdr that holds the shared Agent initial prompt
    When the Primary begins launching the shared Agent
    Then Herdr observes tab creation, Pi startup, readiness, and prompt in order
    And the Agent launch result is still pending
    When Herdr acknowledges the initial prompt
    Then the Agent launch returns launched
    And ListAgents marks the launched runtime as owned

  Scenario: Worktree launch reuses and renames the returned tab
    Given a protocol 17 Herdr that accepts a worktree Agent launch
    When the Primary launches the worktree Agent
    Then worktree creation and tab rename happen before Pi startup
    And Pi startup loads the pi-herdr extension in the returned pane

  Scenario: Failed worktree launch cleans up without recording ownership
    Given a protocol 17 Herdr that rejects the worktree Agent prompt and safe removal
    When the Primary attempts to launch the worktree Agent
    Then the launch reports its cleanup residual
    And safe worktree removal is attempted before closing the managed pane
    And the failed runtime is listed only as a peer
