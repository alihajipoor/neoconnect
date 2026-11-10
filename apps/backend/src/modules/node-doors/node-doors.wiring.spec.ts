import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { PrismaModule } from "../../prisma/prisma.module";
import { PrismaService } from "../../prisma/prisma.service";
import { NodesModule } from "../nodes/nodes.module";
import { NodesService } from "../nodes/nodes.service";
import { NodeDoorsService } from "./node-doors.service";

/** NodesService takes the learner as an optional dependency, so that the
 * specs building it by hand need not pass one. The cost of optional is
 * that a module forgetting to provide it fails silently: a node coming
 * online would just never be asked. This is the check that it is there. */
describe("the nodes module is given the door learner", () => {
  it("so a node coming online is asked for its door", async () => {
    const prisma = {
      node: {
        findUnique: jest.fn().mockResolvedValue({ status: "OFFLINE", name: "alpha" }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, NodesModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    const doors = moduleRef.get(NodeDoorsService, { strict: false });
    const learnSoon = jest.spyOn(doors, "learnSoon").mockImplementation(() => undefined);

    await moduleRef.get(NodesService, { strict: false }).setStatus("n1", "ONLINE");

    expect(learnSoon).toHaveBeenCalledWith("n1");
    await moduleRef.close();
  });
});
