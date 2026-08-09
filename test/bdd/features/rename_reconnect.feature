Feature: Rename synchronization and socket recovery
  Live names remain coherent while read and event transports recover safely.

  Scenario: A valid session rename updates the Agent route and tab label
    Given a Spawned runtime named old-name
    When its Pi session name changes to new-name
    Then Herdr renames the Agent route before the tab label
    And no Pi name rollback or error notification occurs

  Scenario: A partial rename is compensated on every surface
    Given a Spawned runtime whose new tab label is rejected
    When its Pi session name changes to new-name
    Then Herdr restores the prior tab label and Agent route
    And Pi restores old-name and reports the synchronization failure

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
