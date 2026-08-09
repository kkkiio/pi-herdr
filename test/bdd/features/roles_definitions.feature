Feature: Runtime roles and Agent definitions
  One extension exposes a bounded tool surface and resolves strict, layered definitions.

  Scenario: Primary and Spawned roles have exact control tool surfaces
    Given a Pi tool registration recorder
    When pi-herdr registers Primary and Spawned control tools
    Then Primary has Agent, StopAgent, ListAgents, and SendMessage
    And Spawned has only ListAgents and SendMessage

  Scenario: Outside Herdr the extension is silent
    Given HERDR_ENV is not 1
    When the pi-herdr extension receives session_start
    Then it registers no control tools or user command and emits no notification

  Scenario: Real Pi RPC parses the role flag and loads the extension surface
    Given a fake protocol 17 Herdr for real Pi RPC sessions
    When real Pi RPC starts once as Primary and once as Spawned
    Then the Primary RPC session exposes exactly four pi-herdr tools and the agents command
    And the Spawned RPC session exposes exactly two pi-herdr tools and no agents command

  Scenario: A malformed selected definition never falls through to lower layers
    Given a malformed project definition shadows a valid bundled definition
    When the selected definition is loaded
    Then definition loading reports the project schema error

  Scenario: Model resolution uses bundled preference then the Primary fallback
    Given a custom definition without a model and authenticated Primary models
    When launch plans are resolved from bundled model preferences
    Then the first matching normalized bundled model is selected
    And unavailable bundled models inherit the Primary model
    And an unavailable explicit model override is rejected
