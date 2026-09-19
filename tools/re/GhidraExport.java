// Ghidra headless post-analysis GhidraScript (Java -- works without PyGhidra).
// Exports a compact JSON of functions (entry, name, size, caller count) after auto-analysis
// of the dumped CoDWaW image, so our capstone tooling and the t4-sp-map doc can be
// cross-checked against Ghidra's view. Addresses/names only -- never the decompiled code.
// Invoked by run_ghidra.sh via analyzeHeadless -postScript GhidraExport.java
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.symbol.Reference;
import java.io.FileWriter;

public class GhidraExport extends GhidraScript {
    @Override
    public void run() throws Exception {
        FunctionManager fm = currentProgram.getFunctionManager();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"image_base\":").append(currentProgram.getImageBase().getOffset());
        sb.append(",\"functions\":[");
        boolean first = true;
        for (Function f : fm.getFunctions(true)) {
            long entry = f.getEntryPoint().getOffset();
            long size = f.getBody().getNumAddresses();
            int callers = 0;
            for (Reference r : getReferencesTo(f.getEntryPoint())) {
                if (r.getReferenceType().isCall()) callers++;
            }
            if (!first) sb.append(",");
            first = false;
            String name = f.getName().replace("\\", "\\\\").replace("\"", "\\\"");
            sb.append("{\"entry\":").append(entry)
              .append(",\"name\":\"").append(name).append("\"")
              .append(",\"size\":").append(size)
              .append(",\"callers\":").append(callers)
              .append(",\"thunk\":").append(f.isThunk()).append("}");
        }
        sb.append("]}");
        String path = "C:\\Users\\b\\ZombiesDev\\dumps\\cache\\ghidra-funcs.json";
        FileWriter w = new FileWriter(path);
        w.write(sb.toString());
        w.close();
        println("[GhidraExport] wrote " + fm.getFunctionCount() + " functions to " + path);
    }
}
