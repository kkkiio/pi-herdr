Feature: Live Agent discovery and messaging
  Discovery preserves Herdr data and communication uses live name or pane routes.

  Scenario: ListAgents preserves status and distinguishes owned Agents from peers
    Given a Primary that has launched one Agent beside a live peer
    When it lists the live Herdr Agents
    Then the owned Agent keeps its done status and Herdr fields
    And the other runtime keeps its blocked status and is a peer

  Scenario: SendMessage resolves name and pane targets and emits a reply envelope
    Given a protocol 17 Herdr with one named and one unnamed target
    When the Primary sends messages by name and by pane ID
    Then Herdr resolves both supplied routes
    And each prompt prefers the target name and preserves an escaped reply envelope

  Scenario: StopAgent cannot close its caller
    Given a protocol 17 Herdr whose requested stop target is the caller
    When the Primary tries to stop itself
    Then StopAgent rejects the self stop without closing a pane
