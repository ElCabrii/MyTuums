import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import { streamFixtureKey, streamFixtureUpload } from "../../../../e2e/stream-fixture.js";

class Video extends RpcTarget {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly uid: string,
  ) {
    super();
  }

  async details() {
    const object = await this.bucket.get(streamFixtureKey(this.uid));
    if (!object) {
      const error = new Error("Synthetic upload is absent.");
      error.name = "NotFoundError";
      throw error;
    }
    const upload = streamFixtureUpload.parse(await object.json());
    return {
      id: this.uid,
      creator: upload.creator,
      requireSignedURLs: true,
      uploaded: upload.offset === upload.byteSize ? "2026-09-11T00:00:00Z" : null,
      // This fixture proves upload recovery and pending-post UI. The jobs suite
      // separately owns ready-video publication and caption processing.
      readyToStream: false,
      status: { state: "inprogress" },
      duration: 6,
      input: { width: 640, height: 360 },
    };
  }

  async delete() {
    await this.bucket.delete(streamFixtureKey(this.uid));
  }
}

export default class StreamFixture extends WorkerEntrypoint<{ MEDIA: R2Bucket }> {
  video(uid: string) {
    return new Video(this.env.MEDIA, uid);
  }
}
