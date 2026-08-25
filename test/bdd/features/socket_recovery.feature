Feature: Socket recovery
  Read and event transports recover safely without replaying mutations.

  Scenario: Reads retry once while mutations are never replayed
    Given a Herdr transport that drops the first read and every close mutation
    When the client reads and then attempts a close mutation
    Then the read succeeds on its second independent connection
    And the close mutation fails after exactly one request

  Scenario: A dropped event stream reconnects with dotted subscriptions
    Given an acknowledged event stream that drops once
    When the client receives an event from the replacement stream
    Then both subscriptions use independent connections and dotted event types
    And reconnect readiness is reported without losing the pushed event
