import { Router } from "express";
import { createUpload ,checkChunks,uploadChunk,createManifest,commitUpload,listVersions,restoreVersion} from "../controllers/controllers.js";
const router = Router()

router.post("/uploads", createUpload)
router.post("/chunks/check", checkChunks);
router.put("/chunks/:hash", uploadChunk);
router.put("/uploads/:uploadId/manifest", createManifest);
router.post("/uploads/:uploadId/commit", commitUpload);
router.get("/versions", listVersions);
router.post("/versions/:versionId/restore", restoreVersion);

export default router