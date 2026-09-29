-- CreateTable
CREATE TABLE "ManifestEntry" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mtime" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManifestEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManifestChunk" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ManifestChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManifestEntry_versionId_path_key" ON "ManifestEntry"("versionId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "ManifestChunk_entryId_position_key" ON "ManifestChunk"("entryId", "position");

-- AddForeignKey
ALTER TABLE "ManifestEntry" ADD CONSTRAINT "ManifestEntry_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "Version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestChunk" ADD CONSTRAINT "ManifestChunk_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ManifestEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestChunk" ADD CONSTRAINT "ManifestChunk_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "Chunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
