import "dotenv/config";
import app from "./src/app.js";


app.listen(8000, () => {
    console.log("Server is running on port 8000")
})