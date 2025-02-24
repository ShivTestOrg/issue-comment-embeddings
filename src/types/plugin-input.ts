import { StaticDecode, Type as T } from "@sinclair/typebox";

/**
 * This should contain the properties of the bot config
 * that are required for the plugin to function.
 *
 * The kernel will extract those and pass them to the plugin,
 * which are built into the context object from setup().
 */
export const pluginSettingsSchema = T.Object(
  {
    matchThreshold: T.Number({ default: 0.95, description: "The minimum similarity score when considering existing issues to be duplicates." }),
    warningThreshold: T.Number({ default: 0.75, description: "Issues above this similarity score will be marked as a potential duplicate" }),
    jobMatchingThreshold: T.Number({ default: 0.75, description: "The minimum similarity score when considering users to be suitable for a job." }),
    alwaysRecommend: T.Optional(
      T.Number({ default: 0, description: "If set to a value greater than 0, the bot will always recommend contributors, regardless of the similarity score." })
    ),
    enableRedaction: T.Optional(
      T.Boolean({ default: true, description: "If set to false, private content will not be redacted" })
    ),
  },
  { default: {} }
);

export type PluginSettings = StaticDecode<typeof pluginSettingsSchema>;
