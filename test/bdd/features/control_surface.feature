Feature: Control surface and model awareness
  One extension exposes a uniform control tool surface and resolves explicit model overrides.

  Scenario: The extension registers one uniform control tool surface
    Given a Pi tool registration recorder
    When pi-herdr registers its control tools
    Then the surface has Agent, ListAgents, and SendMessage

  Scenario: Outside Herdr the extension is silent
    Given HERDR_ENV is not 1
    When the pi-herdr extension receives session_start
    Then it registers no control tools or user command and emits no notification

  Scenario: Real Pi RPC loads the extension surface inside Herdr
    Given a fake protocol 17 Herdr for real Pi RPC sessions
    When a real Pi RPC session starts inside Herdr
    Then the RPC session exposes exactly four pi-herdr tools and the agents command

  Scenario: Model resolution honors explicit candidates then the Primary model
    Given authenticated Primary models
    When launch plans are resolved from explicit model preferences
    Then the first matching normalized override model is selected
    And a missing model override inherits the Primary model
    And an unavailable explicit model override is rejected

  Scenario: Model awareness notes list only available noted models
    When model awareness notes are computed for available model ids "deepseek-v4-flash, acme/kimi-3"
    Then the notes mention "deepseek-v4-flash" and "kimi-3" but not "gpt-5.6-sol"

  Scenario: Model awareness notes disappear when no noted model is available
    When model awareness notes are computed for available model ids "some-other-model"
    Then no model awareness notes are produced
