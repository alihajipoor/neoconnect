import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChannelType, Collection, type ModalSubmitInteraction } from "discord.js";

import { handleTicketModal } from "./tickets.js";

/** A modal submission from #open-a-ticket, with a channel whose thread
 * creation does what `create` says. */
function submission(create: (options: Record<string, unknown>) => Promise<unknown>) {
  const created: Record<string, unknown>[] = [];
  const replies: unknown[] = [];
  const interaction = {
    deferReply: () => Promise.resolve(),
    editReply: (message: unknown) => {
      replies.push(message);
      return Promise.resolve();
    },
    guild: { roles: { cache: new Collection<string, { id: string; name: string }>() } },
    channel: {
      type: ChannelType.GuildText,
      threads: {
        create: (options: Record<string, unknown>) => {
          created.push(options);
          return create(options);
        },
      },
    },
    member: null,
    user: { id: "111", username: "member" },
    fields: {
      getTextInputValue: (id: string) => (id === "subject" ? "Payment did not activate" : "My order at 10:02, email x"),
    },
  };
  return { interaction: interaction as unknown as ModalSubmitInteraction, created, replies };
}

describe("opening a ticket", () => {
  it("never falls back to a public thread when the private one cannot be made", async () => {
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const { interaction, created, replies } = submission(() => Promise.reject(new Error("Service Unavailable")));
      await handleTicketModal(interaction);

      // One attempt, private. The old fallback made a second, public one
      // and posted the member's details into it.
      assert.equal(created.length, 1);
      assert.equal(created[0].type, ChannelType.PrivateThread);
      assert.equal(replies.length, 1);
      assert.match(String(replies[0]), /could not be opened right now, and nothing was posted/);
    } finally {
      console.error = quiet;
    }
  });

  it("opens a private thread and posts the details into it", async () => {
    const sent: unknown[] = [];
    const added: string[] = [];
    const { interaction, created, replies } = submission(() =>
      Promise.resolve({
        id: "999",
        members: { add: (id: string) => Promise.resolve(void added.push(id)) },
        send: (message: unknown) => Promise.resolve(void sent.push(message)),
      }),
    );
    await handleTicketModal(interaction);

    assert.equal(created.length, 1);
    assert.equal(created[0].type, ChannelType.PrivateThread);
    assert.equal(created[0].invitable, false);
    assert.deepEqual(added, ["111"]);
    assert.equal(sent.length, 1);
    assert.match(String(replies[0]), /Your ticket is open/);
  });
});
