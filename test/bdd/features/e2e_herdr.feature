@herdr-e2e
Feature: Real Herdr end-to-end lifecycle
  The Agent launch transaction runs against a real Herdr 0.7.5 server and a
  real Pi process backed by a faux OpenAI-compatible model provider. Only the
  model endpoint is doubled.

  Scenario: Shared workspace launch against real Herdr
    Given a real Herdr server with a caller pane
    When the Primary launches a shared Agent named "e2e-worker"
    Then the launch returns launched with a real pane identity
    And the real Herdr session shows the Agent tab "e2e-worker"
    And the faux provider received the spawned system prompt and the initial request
    And the spawned Pi rendered the faux reply in its pane
    And ListAgents marks the real runtime as owned
