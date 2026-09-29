import express from "express"
import router from "./routes/routes.js"

const app = express()


app.use(express.json())
app.use(
  "/chunks",
  express.raw({
    type: "application/octet-stream",
    limit: "2mb",
  })
);

app.use(router)

export default app